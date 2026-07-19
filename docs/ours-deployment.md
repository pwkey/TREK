# Deployment — how code gets from `personal` to the live app

Live app: <https://460planner.pwkconsulting.org>

## The pipeline

```
git push origin personal
        │
        ├─ GitHub webhook  →  http://178.105.244.67:8000/webhooks/source/github/events/manual
        │                     (HMAC-signed; secret stored on the Coolify app)
        ↓
Coolify (app "460tp", id 4) builds the Dockerfile and swaps the container
        ↓
container tagged with the commit SHA, served through Traefik
```

There is **no local Docker involved**. Nothing is built on the laptop.

## Checking what is actually live

Don't assume a push deployed. Three cheap checks, in order of authority:

```bash
# 1. Which commit is the running container built from?
ssh root@178.105.244.67 'docker ps --filter name=sh0vth8 --format "{{.Image}}\t{{.Status}}"'

# 2. Does the served bundle contain the thing you just shipped?
curl -s https://460planner.pwkconsulting.org/ | grep -o '/assets/index-[^"]*\.js'
curl -s "https://460planner.pwkconsulting.org/assets/index-XXXX.js" | grep -c "some new string"

# 3. Deployment history and failures
ssh root@178.105.244.67 'docker exec coolify-db psql -U coolify -t -A -F"|" \
  -c "select created_at,status,commit from application_deployment_queues \
      where application_id='"'"'4'"'"' order by created_at desc limit 5;"'
```

A `failed` row in check 3 is the whole answer. To read why:

```bash
ssh root@178.105.244.67 'docker exec coolify-db psql -U coolify -t -A \
  -c "select logs from application_deployment_queues where application_id='"'"'4'"'"' \
      order by created_at desc limit 1;"'
```

## Deploying by hand

If the webhook is down or you want to force a rebuild:

```bash
ssh root@178.105.244.67 'docker exec coolify php artisan tinker --execute="
\$app = App\Models\Application::find(4);
\$uuid = (string) new Visus\Cuid2\Cuid2();
queue_application_deployment(application: \$app, deployment_uuid: \$uuid, force_rebuild: true, is_api: true);
echo \$uuid;
"'
```

Then poll `application_deployment_queues` for that `deployment_uuid` until `finished`.

## Things that have actually bitten us

**The client build stage only gets `client/`.** The Dockerfile does `COPY client/ ./`,
so anything outside that directory does not exist at build time. A prebuild step
that reached for `docs/ours-user-guide.md` threw `ENOENT` and failed **every deploy
for three weeks** — silently, because nobody was watching the server and the local
build (where `docs/` does exist) always passed. Prebuild steps must degrade
gracefully when their inputs aren't in the Docker context.

**Auto-deploy off + no webhook = pushes go nowhere.** Both were true at once, which
made "I pushed it" and "it's live" quietly different statements. If something you
shipped isn't showing up, run check 1 above *before* blaming PWA caching.

**PWA caching is the second suspect, not the first.** Once check 2 confirms the new
bundle is being served, then it's the installed app holding old code — service
worker unregister / clear site data. Before that, it's a server problem.

## Rotating the webhook secret

```bash
SECRET=$(openssl rand -hex 24)
ssh root@178.105.244.67 "docker exec coolify php artisan tinker --execute='
\$a = App\Models\Application::find(4); \$a->manual_webhook_secret_github = \"$SECRET\"; \$a->save();'"
gh api repos/pwkey/TREK/hooks/<id> -X PATCH -f config[secret]="$SECRET" \
  -f config[url]="http://178.105.244.67:8000/webhooks/source/github/events/manual" \
  -f config[content_type]=json
```

The webhook posts over **plain HTTP** — the Coolify instance has no FQDN, so there's
no TLS cert to serve it on. The HMAC signature still prevents forged deploy
triggers, and the payload is public-repo commit metadata, so the exposure is low.
Giving Coolify a real hostname and switching the URL to `https://` would close it
properly.
