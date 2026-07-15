# Switchboard Tray Binary - Cross-compilation Makefile
# Builds native tray binaries for all supported platforms.
# macOS requires CGO_ENABLED=1 for Cocoa frameworks.
# Linux uses CGO_ENABLED=0 for static linking (AppIndicator).

LDFLAGS := -s -w
BIN_PREFIX := switchboard-tray
OUT_DIR := ../tray-packages

.PHONY: all clean darwin-arm64 darwin-x64 linux-x64

all: darwin-arm64 darwin-x64 linux-x64

darwin-arm64:
	@mkdir -p $(OUT_DIR)/@switchboard/tray-darwin-arm64/bin
	CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o $(OUT_DIR)/@switchboard/tray-darwin-arm64/bin/$(BIN_PREFIX) .
	@chmod +x $(OUT_DIR)/@switchboard/tray-darwin-arm64/bin/$(BIN_PREFIX)
	@echo "✓ darwin/arm64"

darwin-x64:
	@mkdir -p $(OUT_DIR)/@switchboard/tray-darwin-x64/bin
	CGO_ENABLED=1 GOOS=darwin GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o $(OUT_DIR)/@switchboard/tray-darwin-x64/bin/$(BIN_PREFIX) .
	@chmod +x $(OUT_DIR)/@switchboard/tray-darwin-x64/bin/$(BIN_PREFIX)
	@echo "✓ darwin/x64"

linux-x64:
	@mkdir -p $(OUT_DIR)/@switchboard/tray-linux-x64/bin
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o $(OUT_DIR)/@switchboard/tray-linux-x64/bin/$(BIN_PREFIX) .
	@chmod +x $(OUT_DIR)/@switchboard/tray-linux-x64/bin/$(BIN_PREFIX)
	@echo "✓ linux/x64"

clean:
	rm -rf $(OUT_DIR)
	rm -f $(BIN_PREFIX)-*
