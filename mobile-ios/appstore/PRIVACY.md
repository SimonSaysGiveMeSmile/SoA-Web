# Privacy Policy — Son of Anton

_Last updated: 2026-07-01_

Son of Anton ("the app") is a client for a **Son of Anton terminal server that you
run and control**. This policy explains what the app does and does not do with
your information.

## Summary
- **No account, no sign-up.** The app does not create or require an account with us.
- **No analytics, no tracking, no advertising.** The app contains no third‑party
  analytics, ad, or tracking SDKs.
- **We do not collect, store, or transmit your data to ourselves.** The app talks
  only to the backend server URL that you configure.

## What the app connects to
The app connects to a backend server that **you** specify (your own machine, your
own server, or a secure tunnel you operate). All terminal input and output flows
between your device and that server over a WebSocket. We (the developer) never
receive, see, or store that traffic. Use a secure (`https`/`wss`) endpoint so the
connection is encrypted in transit.

## Device permissions
The app requests these only when you explicitly use the related feature, and any
data captured is sent only to **your** configured backend — never to us:
- **Microphone** — voice input to your terminal sessions (when you tap the mic).
- **Camera** — sending a photo to a session (when you tap the camera).
- **Photo Library** — attaching an existing photo to a session (when you choose it).

You can revoke any of these at any time in iOS Settings → Son of Anton.

## Data storage on your device
The app stores small preferences locally on your device (e.g. your backend URL,
theme, and font size). This never leaves your device except as needed to connect
to the backend you chose. Deleting the app removes this data.

## Children
The app is not directed at children and collects no personal information from
anyone.

## Changes
If this policy changes, the updated version will be posted at this URL.

## Contact
Questions: <your support email>  (TODO: add before submission)
