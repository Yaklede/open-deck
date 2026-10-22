`AndroidManifest.axml` is the compiled public manifest from Open Deck 0.9.0,
versionCode 15. It contains package/version/permission declarations, not user data.
The companion updater test wraps it in a synthetic APK ZIP to verify Android binary
XML parsing. It does not install or launch an app or contact a device.
