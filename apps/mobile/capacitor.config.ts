import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.datung.fieldapp',
  appName: 'Datung Field',
  webDir: 'dist',

  // server.url is FORBIDDEN in this project. Setting it makes the WebView
  // load the UI from a remote (or dev) server instead of the assets bundled
  // in the APK. This app must cold-start and function with ZERO connectivity
  // (see /CLAUDE.md rule 9) — a remote URL would make the app a white screen
  // the moment the agent is offline, and it would silently bypass the
  // reviewed, signed bundle. Assets are always served from the APK via the
  // https://localhost origin below. Do not add server.url, even "temporarily"
  // for live reload.
  server: {
    // REQUIRED: 'https' gives the WebView a secure context, which
    // getUserMedia (in-app camera preview) and the Geolocation fallback
    // require. Do not change this.
    androidScheme: 'https',
  },

  android: {
    allowMixedContent: false,
  },
};

export default config;
