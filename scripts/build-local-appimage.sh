#!/usr/bin/env bash
# Build a local AppImage for dogfooding — no GitHub releases involved.
#
#   scripts/build-local-appimage.sh [--install]
#
# The version is bumped to <next-major>.1.0-dogfood.<timestamp>, which is
# always above the public releases, so the built-in auto-updater stays quiet.
# With --install the AppImage is copied to ~/.local/bin and a desktop entry
# is created so it shows up in your launcher.
#
# Two temporary package.json tweaks are required by electron-builder 26
# (electron must live in devDependencies; the repo keeps it in dependencies
# for the upstream publish flow, and the afterAllArtifactBuild hook is a
# publish-only step). Both are restored on exit, including on failure.
#
# Arch notes:
#   sudo pacman -S fuse2          # required to RUN AppImages (Arch ships fuse3)
#   yay -S appimagelauncher       # optional: one-click integration on first run
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
    echo "Installing dependencies first..."
    yarn install
fi

PACKAGE_JSON="package.json"
BACKUP="$(mktemp /tmp/p3x-package.json.XXXXXX)"
cp "$PACKAGE_JSON" "$BACKUP"

restore_package_json() {
    cp "$BACKUP" "$PACKAGE_JSON"
    rm -f "$BACKUP"
}
trap restore_package_json EXIT

# 1. electron → devDependencies (electron-builder 26 hard-errors otherwise)
# 2. strip the publish-only afterAllArtifactBuild hook
node -e "
const fs = require('fs')
const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'))
pkg.devDependencies.electron = pkg.dependencies.electron
delete pkg.dependencies.electron
delete pkg.build.afterAllArtifactBuild
fs.writeFileSync(process.argv[1], JSON.stringify(pkg, null, 4) + '\n')
" "$PACKAGE_JSON"

# <major+1>.1.0-dogfood.<timestamp> — semver-higher than any public build
DOGFOOD_VERSION="$(
    node -p "(() => {
        const v = require('./package.json').version.split('.')
        v[0] = String(Number(v[0]) + 1)
        v[1] = '1'
        v[2] = '0'
        return v.join('.') + '-dogfood.' + Math.floor(Date.now() / 1000)
    })()"
)"

echo "Building P3X OneNote AppImage version $DOGFOOD_VERSION ..."
./node_modules/.bin/electron-builder --linux AppImage \
    --publish never \
    -c.extraMetadata.version="$DOGFOOD_VERSION"

restore_package_json
trap - EXIT

APPIMAGE="$(ls -1 dist/*.AppImage | head -1)"
echo
echo "Built: $APPIMAGE"

if [ "${1:-}" = "--install" ]; then
    mkdir -p ~/.local/bin
    cp "$APPIMAGE" ~/.local/bin/
    chmod +x ~/.local/bin/"$(basename "$APPIMAGE")"

    mkdir -p ~/.local/share/applications
    cat > ~/.local/share/applications/p3x-onenote-dogfood.desktop <<EOF
[Desktop Entry]
Type=Application
Name=P3X OneNote (dogfood)
Exec=$HOME/.local/bin/$(basename "$APPIMAGE")
Icon=book
Categories=Office;Notes;
Comment=OneNote wrapper with global note search (local dogfood build)
EOF
    echo "Installed to ~/.local/bin + desktop entry created. Launch it from your app menu."
else
    echo "Run it directly: ./$APPIMAGE"
    echo "(or re-run with --install to put it in ~/.local/bin and your app menu)"
fi
