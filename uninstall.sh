#!/usr/bin/env bash
# Haul DM — uninstaller.
# Removes everything install.sh dropped. Safe to run multiple times.
set -euo pipefail

if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; RESET=$'\e[0m'
else
  BOLD=""; DIM=""; GREEN=""; RESET=""
fi
log()  { echo -e "${BOLD}${GREEN}==>${RESET} $*"; }
info() { echo -e "${DIM}    $*${RESET}"; }

# Stop any running instance first so the binaries aren't text-busy.
pkill -f "haul-dm" >/dev/null 2>&1 || true
pkill -f "linux-download-manager" >/dev/null 2>&1 || true  # legacy name
pkill -f "browser_native_host" >/dev/null 2>&1 || true
sleep 1

log "Removing binaries"
rm -f "${HOME}/.local/bin/haul-dm"
rm -f "${HOME}/.local/bin/linux-download-manager"      # legacy name

log "Removing app data (${HOME}/.local/share/haul-dm)"
rm -rf "${HOME}/.local/share/haul-dm"
rm -rf "${HOME}/.local/share/linux-download-manager"    # legacy name

# yt-dlp itself is a generally useful tool, leave it installed. We only
# remove the LDM-specific config line we added.
if [[ -f "${HOME}/.config/yt-dlp/config" ]]; then
  log "Cleaning Haul DM entries from yt-dlp config"
  tmp="$(mktemp)"
  grep -vE '^(--js-runtimes|--no-mtime)' "${HOME}/.config/yt-dlp/config" > "${tmp}" || true
  if [[ -s "${tmp}" ]]; then
    mv "${tmp}" "${HOME}/.config/yt-dlp/config"
  else
    rm -f "${tmp}" "${HOME}/.config/yt-dlp/config"
    rmdir --ignore-fail-on-non-empty "${HOME}/.config/yt-dlp" 2>/dev/null || true
  fi
fi

log "Removing desktop entry + icon"
rm -f "${HOME}/.local/share/applications/haul-dm.desktop"
rm -f "${HOME}/.local/share/applications/linux-download-manager.desktop"  # legacy name
rm -f "${HOME}/.local/share/icons/hicolor/256x256/apps/haul-dm.png"
rm -f "${HOME}/.local/share/icons/hicolor/256x256/apps/linux-download-manager.png"  # legacy name

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "${HOME}/.local/share/applications" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
  gtk-update-icon-cache -f -t "${HOME}/.local/share/icons/hicolor/" 2>/dev/null || true

log "Removing browser extension folder (${HOME}/Documents/Haul DM Extension)"
rm -rf "${HOME}/Documents/Haul DM Extension"
rm -rf "${HOME}/Documents/Linux Download Manager Extension"  # legacy name

log "Removing Chromium native messaging host manifests"
for browser_root in \
  "${HOME}/.config/google-chrome/NativeMessagingHosts" \
  "${HOME}/.config/chromium/NativeMessagingHosts" \
  "${HOME}/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "${HOME}/.config/microsoft-edge/NativeMessagingHosts" \
  "${HOME}/.config/vivaldi/NativeMessagingHosts"
do
  if [[ -f "${browser_root}/com.eko.linuxdownloadmanager.json" ]]; then
    rm -f "${browser_root}/com.eko.linuxdownloadmanager.json"
    info "    → removed from $(basename "$(dirname "${browser_root}")")"
  fi
done

echo
log "${BOLD}Uninstalled.${RESET}"
echo "  Don't forget to remove the extension from your browser"
echo "  (chrome://extensions → Remove)."
echo
