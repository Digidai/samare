#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/ModuleCache
compiler=(/usr/bin/swiftc -swift-version 5 -module-cache-path build/ModuleCache)
"${compiler[@]}" Native/DocumentStore.swift Native/Tests/SaveFixture/main.swift -o build/native-save-fixture
"${compiler[@]}" Native/DocumentStore.swift Native/LocalAssets.swift Native/SearchLinks.swift Native/Tests/main.swift -o build/native-tests
"${compiler[@]}" -framework JavaScriptCore Native/QuickLook/PreviewRenderer.swift Native/Tests/QuickLook/main.swift -o build/preview-tests
hostSources=()
for name in Native/*.swift; do if [[ $name != Native/main.swift ]]; then hostSources+=("$name"); fi; done
"${compiler[@]}" -framework AppKit -framework WebKit "${hostSources[@]}" Native/Tests/Host/main.swift -o build/host-tests
"${compiler[@]}" -framework AppKit -framework WebKit "${hostSources[@]}" Native/Tests/FinderDrop/main.swift -o build/finder-drop-tests
./build/native-tests
./build/preview-tests Resources/vendor/editor-libs.js
./build/host-tests --isolated
./build/finder-drop-tests Resources --isolated
"${compiler[@]}" -framework AppKit -framework WebKit "${hostSources[@]}" Native/Tests/Reading/main.swift -o build/reading-tests
./build/reading-tests Resources --isolated

"${compiler[@]}" -framework AppKit -framework WebKit -framework PDFKit Native/DocumentStore.swift Native/PrintDocument.swift Native/Tests/Print/main.swift -o build/print-tests
./build/print-tests

"${compiler[@]}" -framework AppKit -framework WebKit -framework PDFKit Native/DocumentStore.swift Native/PrintDocument.swift Native/Tests/PrintEdges/main.swift -o build/print-edge-tests
./build/print-edge-tests

"${compiler[@]}" -framework AppKit -framework WebKit "${hostSources[@]}" Native/Tests/Revision/main.swift -o build/revision-tests
./build/revision-tests Resources --isolated

"${compiler[@]}" -framework AppKit -framework WebKit "${hostSources[@]}" Native/Tests/WorkspaceControls/main.swift -o build/workspace-controls-tests
./build/workspace-controls-tests Resources --isolated

"${compiler[@]}" -framework AppKit -framework WebKit "${hostSources[@]}" Native/Tests/QuitWindows/main.swift -o build/quit-window-tests
./build/quit-window-tests Resources --isolated
