import React, { useState, useEffect, useRef } from 'react'
import ReactDOM from 'react-dom'
import { LucideIcon, ChevronRight } from 'lucide-react'

interface MenuItem {
  label?: string
  icon?: LucideIcon
  onClick?: () => void
  danger?: boolean
  divider?: boolean
  // [460-fork] Q2 — optional nested submenu. When `submenu` is set,
  // hovering the parent item shows a flyout to the right; clicking a
  // submenu item invokes its onClick and closes both menus.
  submenu?: (MenuItem | false | null | undefined)[]
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null)

  const open = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const close = () => setMenu(null)

  return { menu, open, close }
}

interface ContextMenuProps {
  menu: MenuState | null
  onClose: () => void
}

export function ContextMenu({ menu, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  // [460-fork] Q2 — index of the menu item whose submenu is currently open.
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null)
  const submenuPosRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!menu) return
    setOpenSubmenu(null)
    const handler = () => onClose()
    document.addEventListener('click', handler)
    document.addEventListener('contextmenu', handler)
    return () => {
      document.removeEventListener('click', handler)
      document.removeEventListener('contextmenu', handler)
    }
  }, [menu, onClose])

  useEffect(() => {
    if (!menu || !ref.current) return
    const el = ref.current
    const rect = el.getBoundingClientRect()
    let { x, y } = menu
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8
    if (x !== menu.x || y !== menu.y) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }, [menu])

  if (!menu) return null

  const submenuItems: MenuItem[] = openSubmenu !== null
    ? (menu.items[openSubmenu]?.submenu ?? []).filter(Boolean) as MenuItem[]
    : []

  return ReactDOM.createPortal(
    <>
      <div ref={ref} style={{
        position: 'fixed', left: menu.x, top: menu.y, zIndex: 999999,
        background: 'var(--bg-card)', borderRadius: 10, padding: '4px',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 8px 30px rgba(0,0,0,0.15)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        minWidth: 160,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        animation: 'ctxIn 0.1s ease-out',
      }}>
        {menu.items.filter(Boolean).map((item, i) => {
          if (item.divider) return <div key={i} style={{ height: 1, background: 'var(--border-faint)', margin: '3px 6px' }} />
          const Icon = item.icon
          const hasSubmenu = Array.isArray(item.submenu) && item.submenu.some(Boolean)
          return (
            <button key={i}
              onClick={e => {
                if (hasSubmenu) {
                  // Toggle the submenu instead of invoking the parent's onClick.
                  e.stopPropagation()
                  const rect = e.currentTarget.getBoundingClientRect()
                  submenuPosRef.current = { x: rect.right - 4, y: rect.top }
                  setOpenSubmenu(prev => prev === i ? null : i)
                } else {
                  item.onClick?.()
                  onClose()
                }
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = item.danger ? 'rgba(239,68,68,0.08)' : 'var(--bg-hover)'
                if (hasSubmenu) {
                  const rect = e.currentTarget.getBoundingClientRect()
                  submenuPosRef.current = { x: rect.right - 4, y: rect.top }
                  setOpenSubmenu(i)
                } else {
                  setOpenSubmenu(null)
                }
              }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '7px 10px', borderRadius: 7, border: 'none',
                background: openSubmenu === i ? 'var(--bg-hover)' : 'none',
                cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 12, fontWeight: 500, textAlign: 'left',
                color: item.danger ? '#ef4444' : 'var(--text-primary)',
                transition: 'background 0.1s',
              }}
            >
              {Icon && <Icon size={13} style={{ flexShrink: 0, color: item.danger ? '#ef4444' : 'var(--text-faint)' }} />}
              <span style={{ flex: 1 }}>{item.label}</span>
              {hasSubmenu && <ChevronRight size={12} style={{ flexShrink: 0, color: 'var(--text-faint)' }} />}
            </button>
          )
        })}
        <style>{`@keyframes ctxIn { from { opacity: 0; transform: scale(0.95) } to { opacity: 1; transform: scale(1) } }`}</style>
      </div>

      {/* [460-fork] Q2 — Submenu flyout. Anchored to the right edge of the
          parent item. Submenus only go one level deep. */}
      {openSubmenu !== null && submenuItems.length > 0 && submenuPosRef.current && (
        <div
          onMouseLeave={() => setOpenSubmenu(null)}
          style={{
            position: 'fixed',
            left: Math.min(submenuPosRef.current.x, window.innerWidth - 220),
            top: Math.min(submenuPosRef.current.y, window.innerHeight - submenuItems.length * 32 - 8),
            zIndex: 999999,
            background: 'var(--bg-card)', borderRadius: 10, padding: '4px',
            border: '1px solid var(--border-primary)',
            boxShadow: '0 8px 30px rgba(0,0,0,0.15)',
            backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            minWidth: 180, maxHeight: '60vh', overflowY: 'auto',
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
            animation: 'ctxIn 0.1s ease-out',
          }}
        >
          {submenuItems.map((item, j) => {
            if (item.divider) return <div key={j} style={{ height: 1, background: 'var(--border-faint)', margin: '3px 6px' }} />
            const Icon = item.icon
            return (
              <button key={j}
                onClick={e => {
                  e.stopPropagation()
                  item.onClick?.()
                  onClose()
                }}
                onMouseEnter={e => e.currentTarget.style.background = item.danger ? 'rgba(239,68,68,0.08)' : 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '7px 10px', borderRadius: 7, border: 'none',
                  background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 12, fontWeight: 500, textAlign: 'left',
                  color: item.danger ? '#ef4444' : 'var(--text-primary)',
                  transition: 'background 0.1s',
                }}
              >
                {Icon && <Icon size={13} style={{ flexShrink: 0, color: item.danger ? '#ef4444' : 'var(--text-faint)' }} />}
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </>,
    document.body
  )
}
