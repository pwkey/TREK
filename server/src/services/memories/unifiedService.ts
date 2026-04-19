import { db, canAccessTrip } from '../../db/database';
import { send } from '../notificationService';
import { broadcast } from '../../websocket';
import {
  ServiceResult,
  fail,
  success,
  mapDbError,
  Selection,
} from './helpersService';


function _providers(): Array<{id: string; enabled: boolean}> {
  const rows = db.prepare('SELECT id, enabled FROM photo_providers').all() as Array<{id: string; enabled: number}>;
  return rows.map(r => ({ id: r.id, enabled: r.enabled === 1 }));
} 

function _validProvider(provider: string): ServiceResult<string> {
  const providers = _providers();
  const found = providers.find(p => p.id === provider);
  if (!found) {
    return fail(`Provider: "${provider}" is not supported`, 400);
  }
  if (!found.enabled) {
    return fail(`Provider: "${provider}" is not enabled, contact server administrator`, 400);
  }
  return success(provider);
}




export function listTripPhotos(tripId: string, userId: number): ServiceResult<any[]> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  try {

    const enabledProviders = _providers().filter(p => p.enabled).map(p => p.id);

    if (enabledProviders.length === 0) {
      return fail('No photo providers enabled', 400);
    }

    const photos = db.prepare(`
      SELECT tp.asset_id, tp.provider, tp.user_id, tp.shared, tp.added_at,
             u.username, u.avatar
      FROM trip_photos tp
      JOIN users u ON tp.user_id = u.id
      WHERE tp.trip_id = ?
        AND (tp.user_id = ? OR tp.shared = 1)
        AND tp.provider IN (${enabledProviders.map(() => '?').join(',')})
      ORDER BY tp.added_at ASC
    `).all(tripId, userId, ...enabledProviders);

    return success(photos);
  } catch (error) {
    return mapDbError(error, 'Failed to list trip photos');
  }
}

export function listTripAlbumLinks(tripId: string, userId: number): ServiceResult<any[]> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  
    const enabledProviders = _providers().filter(p => p.enabled).map(p => p.id);

    if (enabledProviders.length === 0) {
      return fail('No photo providers enabled', 400);
    }

  try {
    const links = db.prepare(`
      SELECT tal.id,
             tal.trip_id,
             tal.user_id,
             tal.provider,
             tal.album_id,
             tal.album_name,
             tal.sync_enabled,
             tal.last_synced_at,
             tal.created_at,
             u.username
      FROM trip_album_links tal
      JOIN users u ON tal.user_id = u.id
      WHERE tal.trip_id = ?
        AND tal.provider IN (${enabledProviders.map(() => '?').join(',')})
      ORDER BY tal.created_at ASC
    `).all(tripId, ...enabledProviders);

    return success(links);
  } catch (error) {
    return mapDbError(error, 'Failed to list trip album links');
  }
}

//-----------------------------------------------
// managing photos in trip

function _addTripPhoto(tripId: string, userId: number, provider: string, assetId: string, shared: boolean, albumLinkId?: string): ServiceResult<boolean> {
  const providerResult = _validProvider(provider);
  if (!providerResult.success) {
    return providerResult as ServiceResult<boolean>;
  }
  try {
    const result = db.prepare(
      'INSERT OR IGNORE INTO trip_photos (trip_id, user_id, asset_id, provider, shared, album_link_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(tripId, userId, assetId, provider, shared ? 1 : 0, albumLinkId || null);
    return success(result.changes > 0);
  }
  catch (error) {
    return mapDbError(error, 'Failed to add photo to trip');
  }
}

export async function addTripPhotos(
  tripId: string,
  userId: number,
  shared: boolean,
  selections: Selection[],
  sid: string,
  albumLinkId?: string,
): Promise<ServiceResult<{ added: number; shared: boolean }>> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  if (selections.length === 0) {
    return fail('No photos selected', 400);
  }

  let added = 0;
  for (const selection of selections) {
    const providerResult = _validProvider(selection.provider);
    if (!providerResult.success) {
      return providerResult as ServiceResult<{ added: number; shared: boolean }>;
    }
    for (const raw of selection.asset_ids) {
      const assetId = String(raw || '').trim();
      if (!assetId) continue;
      const result = _addTripPhoto(tripId, userId, selection.provider, assetId, shared, albumLinkId);
      if (!result.success) {
        return result as ServiceResult<{ added: number; shared: boolean }>;
      }
      if (result.data) {
        added++;
      }
    }
  }

  await _notifySharedTripPhotos(tripId, userId, added);
  broadcast(tripId, 'memories:updated', { userId }, sid);
  return success({ added, shared });
}


export async function setTripPhotoSharing(
  tripId: string,
  userId: number,
  provider: string,
  assetId: string,
  shared: boolean,
  sid?: string,
): Promise<ServiceResult<true>> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  try {
    db.prepare(`
      UPDATE trip_photos
      SET shared = ?
      WHERE trip_id = ?
        AND user_id = ?
        AND asset_id = ?
        AND provider = ?
    `).run(shared ? 1 : 0, tripId, userId, assetId, provider);

    await _notifySharedTripPhotos(tripId, userId, 1);
    broadcast(tripId, 'memories:updated', { userId }, sid);
    return success(true);
  } catch (error) {
    return mapDbError(error, 'Failed to update photo sharing');
  }
}

export function removeTripPhoto(
  tripId: string,
  userId: number,
  provider: string,
  assetId: string,
  sid?: string,
): ServiceResult<true> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  try {
    db.prepare(`
      DELETE FROM trip_photos
      WHERE trip_id = ?
        AND user_id = ?
        AND asset_id = ?
        AND provider = ?
    `).run(tripId, userId, assetId, provider);

    broadcast(tripId, 'memories:updated', { userId }, sid);

    return success(true);
  } catch (error) {
    return mapDbError(error, 'Failed to remove trip photo');
  }
}

// ----------------------------------------------
// managing album links in trip

export function createTripAlbumLink(tripId: string, userId: number, providerRaw: unknown, albumIdRaw: unknown, albumNameRaw: unknown): ServiceResult<true> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  const provider = String(providerRaw || '').toLowerCase();
  const albumId = String(albumIdRaw || '').trim();
  const albumName = String(albumNameRaw || '').trim();

  if (!provider) {
    return fail('provider is required', 400);
  }
  if (!albumId) {
    return fail('album_id required', 400);
  }


  const providerResult = _validProvider(provider);
  if (!providerResult.success) {
    return providerResult as ServiceResult<true>;
  }

  try {
    const result = db.prepare(
      'INSERT OR IGNORE INTO trip_album_links (trip_id, user_id, provider, album_id, album_name) VALUES (?, ?, ?, ?, ?)'
    ).run(tripId, userId, provider, albumId, albumName);

    if (result.changes === 0) {
      return fail('Album already linked', 409);
    }

    return success(true);
  } catch (error) {
    return mapDbError(error, 'Failed to link album');
  }
}

export function removeAlbumLink(tripId: string, linkId: string, userId: number): ServiceResult<true> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  try {
    db.transaction(() => {
      db.prepare('DELETE FROM trip_photos WHERE trip_id = ? AND album_link_id = ?')
        .run(tripId, linkId);
      db.prepare('DELETE FROM trip_album_links WHERE id = ? AND trip_id = ? AND user_id = ?')
        .run(linkId, tripId, userId);
    })();
    
    return success(true);
  } catch (error) {
    return mapDbError(error, 'Failed to remove album link');
  }
}


//-----------------------------------------------
// notifications helper

async function _notifySharedTripPhotos(
  tripId: string,
  actorUserId: number,
  added: number,
): Promise<ServiceResult<void>> {
  if (added <= 0) return fail('No photos shared, skipping notifications', 200);

  try {
    const actorRow = db.prepare('SELECT username, email FROM users WHERE id = ?').get(actorUserId) as { username: string | null, email: string | null };

    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;

    
    send({ event: 'photos_shared', actorId: actorUserId, scope: 'trip', targetId: Number(tripId), params: { trip: tripInfo?.title || 'Untitled', actor: actorRow?.email || 'Unknown', count: String(added), tripId: String(tripId) } }).catch(() => {});
    return success(undefined);
  } catch {
    return fail('Failed to send notifications', 500);
  }
}
