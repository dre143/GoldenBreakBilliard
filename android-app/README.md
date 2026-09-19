# Golden Break tablet app

Copied from the Marimar Inn tablet app. This small Android app opens the live Golden Break site
(https://golden-break-billiard.vercel.app) **full screen**, and adds what Chrome can't do:

- **Direct Bluetooth printing** to cheap 58mm thermal printers (classic Bluetooth / SPP). No RawBT needed.
- **Cash drawer** kick over the same Bluetooth connection.
- **Full screen and screen always on**: the status and navigation bars are hidden (swipe from the edge to
  show them for a moment).
- **Recovers on its own**: retries every 2 seconds if the page can't load, and restarts itself if Android
  kills it for memory. With the site's offline cache (`sw.js`), it reopens even without internet.

## Install on the billiards tablet

1. Copy the newest APK to the tablet (see **APK versions** below) and open it. Allow "Install unknown apps"
   if Android asks.
2. Pair the thermal printer in **Android Settings → Bluetooth** (not inside the app).
3. Open **Golden Break**. Allow **Nearby devices** when Android asks (needed for Bluetooth).
4. In the app: sidebar → **Thermal printer** → tap the printer's name → **Print test**.

Optional kiosk lock: Android **Settings → Security → App pinning** (or "Pin app"), then pin Golden Break so
staff can't leave the app without the PIN.

## Build

Open this folder in Android Studio and run **Build → Build APK(s)**, or from a terminal:

```
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
gradlew.bat assembleDebug
```

The APK is `app/build/outputs/apk/debug/app-debug.apk`. The site URL is `app_url` in
`app/src/main/res/values/strings.xml`. The launcher icon is made from `../assets/logo-mark.png` by
`scripts/build-launcher-icon.py`.

## APK versions

Each update is a **new file** with a higher number, and `versionCode` in `app/build.gradle.kts` goes up by one:

- `releases/GoldenBreak-tablet-v1.apk`: first version (full screen, direct Bluetooth printing, cash drawer,
  offline reload)
- The next change will be `v2`, and so on.

Install the **highest** version number.
