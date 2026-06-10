# Asset Provenance

This document records the origin, generation method, rights holder, license, privacy review, and SHA-256 digest of the non-code assets distributed with Input Panel.

- Snapshot date: 2026-08-17
- Project copyright: Copyright (C) 2026 xxxxxgold
- Project license: GPL-3.0-only
- Digest format: lowercase SHA-256 of the exact distributed file bytes

## First-party brand and sound assets

The Input Panel mark was authored specifically for this project as geometric SVG markup. It contains no embedded bitmap, font, third-party logo, trademark, stock media, or likeness. `src/assets/project-logo.svg` is the source master. Web images, the floating-orb avatar, and the Tauri icon suite are mechanical derivatives of that master.

The notification sound was synthesized locally without external samples. The distributed WAV is 0.43 seconds of 48 kHz, stereo, signed 16-bit PCM audio.

All files in this section are copyright xxxxxgold and distributed under GPL-3.0-only.

| File | Role and generation method | SHA-256 |
| --- | --- | --- |
| `src/assets/project-logo.svg` | Original 1024 x 1024 vector source master, authored as SVG markup | `3e426b26548e2a33e060aae537456952eb6048e2f9d4e6ff0a839129c6e4b59c` |
| `src/assets/project-logo.webp` | 512 x 512 WebP render of the source master | `17d561c8836332a378543c2797f0ce4552ab824541fe3f560d748c690a197797` |
| `src/assets/project-logo-64.webp` | 64 x 64 WebP render of the source master | `9897335efd518d090563e49b883c38afa89ad710eeadfa7b0cc535ccfe4a5a1a` |
| `src/assets/floating-orb-avatar.png` | 512 x 512 RGBA PNG render of the source master for the floating UI | `160fa8f05b1d233c115fe6ed4e122c9dbb3ab6a915f5d4e1f7c8ef454896b335` |
| `src-tauri/resources/sounds/input-panel-notification.wav` | Locally synthesized notification tone; no sampled source material | `6b4cc9f207f141331175f6e8b740ab6ee6c9d47de95f5cefa4e6b39c270271e3` |

## Tauri icon suite

The icon suite was generated locally from `src/assets/project-logo.svg` with the Tauri CLI icon generator. PNG, ICO, ICNS, Android, iOS, and Windows Store variants are mechanical size and container conversions. The Android XML files are generator metadata for the same mark. No external artwork was introduced.

| File | SHA-256 |
| --- | --- |
| `src-tauri/icons/128x128.png` | `30bb2f9f559457639dbfac0ff62daf61ab7dd4ab3d3d2b8076951407226abbf3` |
| `src-tauri/icons/128x128@2x.png` | `ba493c78e4af71a9a2a54c7934eea7e057228abf4e7599cbdf53b7a062ec0544` |
| `src-tauri/icons/32x32.png` | `cbfea186e84b09da40be42fc7a3d3a0e4a36a013dbcbbe12b00b7465f630c229` |
| `src-tauri/icons/64x64.png` | `d26b53b93582d54cbf67558b3d440895a55724d22f8415b1fc06866f18888e5e` |
| `src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher.xml` | `760d4b8a06bf7163dd010c33ad2cac9e4a75fa0177afaba042f83e311eef0c3e` |
| `src-tauri/icons/android/mipmap-hdpi/ic_launcher.png` | `010ec0be288c5ba8396fca1111fbdc6301434da5538eb4cdaa5e5ba26a5401a7` |
| `src-tauri/icons/android/mipmap-hdpi/ic_launcher_foreground.png` | `d17e01ecf1f0e66ee470f71f99f1d8dd59784017594c595d57c40b67266a95d6` |
| `src-tauri/icons/android/mipmap-hdpi/ic_launcher_round.png` | `55711ea6ed863fa51a12aa6f8fa5128c2e956b159ef6016f2eae20c49b7d0bc8` |
| `src-tauri/icons/android/mipmap-mdpi/ic_launcher.png` | `8c827eaa03e11c01433ca4f47b16fca2b4ac9e5b363ecdfada5f1758b6e0e060` |
| `src-tauri/icons/android/mipmap-mdpi/ic_launcher_foreground.png` | `d41241ea1c7524e0d85030db77c771fa4af05d1e51ce6e6f3ebd1fc6856611a6` |
| `src-tauri/icons/android/mipmap-mdpi/ic_launcher_round.png` | `d604f7f386d217d4237fbd32e75596d2fc24faf3e1765c35de0c229871c0c431` |
| `src-tauri/icons/android/mipmap-xhdpi/ic_launcher.png` | `0c38ebe1a45b2059cc789a3107b3477804b067b89965db86da5c3271df3dee43` |
| `src-tauri/icons/android/mipmap-xhdpi/ic_launcher_foreground.png` | `ec1cc09152561e235c0b89cb2d9a34424fba913e63e8044c0fc474a59f218ed6` |
| `src-tauri/icons/android/mipmap-xhdpi/ic_launcher_round.png` | `f75397a4885a5cbb4378c80bda9e3d579d7ca3fd5c2cf9792eade583072a5b55` |
| `src-tauri/icons/android/mipmap-xxhdpi/ic_launcher.png` | `76f9a4519f7291110972a294461b07f94a68c50964f877a407b22f1a3820e8b8` |
| `src-tauri/icons/android/mipmap-xxhdpi/ic_launcher_foreground.png` | `81034109723364c72f5c6b9593ddc2997bbff89473e16b657b34858ee8c797dd` |
| `src-tauri/icons/android/mipmap-xxhdpi/ic_launcher_round.png` | `4a51ff244d3df18f2bff0f1eb984bd1794bfa0732ddf3aaf12e05967ce5b02c5` |
| `src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher.png` | `d0fa23f29bbbec141af6ab7d898c83d566851ffe75d604b9d9d166082368813a` |
| `src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_foreground.png` | `0577ce870a5911380708cdba441d4d9713a8e12919462765b2f8d9f24a5e0347` |
| `src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_round.png` | `1b2519bd49f895e0270d8c562c0397e0356658588a98e864352d6baff5d2710f` |
| `src-tauri/icons/android/values/ic_launcher_background.xml` | `0687336f0ccc6f7ee09c7c95110667c63b75931238df779a21af401fb864cd34` |
| `src-tauri/icons/icon.icns` | `601e0c848cb667b9562a6eda7e0cfc8eb8e779d8a4adb53b0a444eb47a94b440` |
| `src-tauri/icons/icon.ico` | `98156074bab193c43f1d287bd43b203bd6841112031e07ada08ee79cda827a66` |
| `src-tauri/icons/icon.png` | `bf066e132f34dbcb7916e85be42844fa729f1c854a726d376fc5947e931d3e5f` |
| `src-tauri/icons/ios/AppIcon-20x20@1x.png` | `9feb924508cdbb26a9e6208068501175270fc93d9c94f22b7941c94120ae4bb3` |
| `src-tauri/icons/ios/AppIcon-20x20@2x-1.png` | `8440cdfb542c16c559ec59bea0c0761c1c8282746a8e883af753b533d23402f8` |
| `src-tauri/icons/ios/AppIcon-20x20@2x.png` | `8440cdfb542c16c559ec59bea0c0761c1c8282746a8e883af753b533d23402f8` |
| `src-tauri/icons/ios/AppIcon-20x20@3x.png` | `eb2a144052c69a201b88d3b54603166e6d6bc645896e43b7d5e4d472e579e566` |
| `src-tauri/icons/ios/AppIcon-29x29@1x.png` | `cfd05c7caf0ec2aae4adc182ae99e121a054451e8c6d441450893b1e0c803397` |
| `src-tauri/icons/ios/AppIcon-29x29@2x-1.png` | `0cdf0e5bcb1ee864df6fdb3023b829ccae23e8e48a49ff0c00dd9aff86096915` |
| `src-tauri/icons/ios/AppIcon-29x29@2x.png` | `0cdf0e5bcb1ee864df6fdb3023b829ccae23e8e48a49ff0c00dd9aff86096915` |
| `src-tauri/icons/ios/AppIcon-29x29@3x.png` | `69639431cae70b2143dcc6ba2f163d5febe1ad59090e9c3e9c673ed6434acef1` |
| `src-tauri/icons/ios/AppIcon-40x40@1x.png` | `8440cdfb542c16c559ec59bea0c0761c1c8282746a8e883af753b533d23402f8` |
| `src-tauri/icons/ios/AppIcon-40x40@2x-1.png` | `3c8b69edcf14beac6ee664bed39ae9851123360c4cb80dd4e15145a28e1e91a2` |
| `src-tauri/icons/ios/AppIcon-40x40@2x.png` | `3c8b69edcf14beac6ee664bed39ae9851123360c4cb80dd4e15145a28e1e91a2` |
| `src-tauri/icons/ios/AppIcon-40x40@3x.png` | `1ca53cb146186eb10291c056fe354ce44e35fd0d78348969b1e783a161bb3627` |
| `src-tauri/icons/ios/AppIcon-512@2x.png` | `9c8bbc0ca20cd9f17bf59b19b74f9a536ec08b1314125a89175a3a79756fc37e` |
| `src-tauri/icons/ios/AppIcon-60x60@2x.png` | `1ca53cb146186eb10291c056fe354ce44e35fd0d78348969b1e783a161bb3627` |
| `src-tauri/icons/ios/AppIcon-60x60@3x.png` | `2d1172fa04658e4ba41e6b4b8c67cc8bd6a59ecff2bd5a6f0ffd4bb71ce2eab3` |
| `src-tauri/icons/ios/AppIcon-76x76@1x.png` | `294883c67f9c272376888ac0e321b023bcefbd634f4975dedaa05f5452fec609` |
| `src-tauri/icons/ios/AppIcon-76x76@2x.png` | `1ce4891c6af9be600ac2297456303ee16e00df1a78429863602b96a763d72581` |
| `src-tauri/icons/ios/AppIcon-83.5x83.5@2x.png` | `9683cff35f44e11597637b14d224a30256002cc55db54a6fef50dd52dd359541` |
| `src-tauri/icons/Square107x107Logo.png` | `33b9e33b08e1b77817b7ccfe783b8b1c7a3ad75257724af34fe5cad1e5df5548` |
| `src-tauri/icons/Square142x142Logo.png` | `c714298fe3eb6481c860a4f60b5f572d6483b178296c8861ee3dd3b14896e697` |
| `src-tauri/icons/Square150x150Logo.png` | `5496f8f5e9f90b283db3ced83f27f5f8b13dacec5640ec3bdecc9a47af4f9265` |
| `src-tauri/icons/Square284x284Logo.png` | `5ab762bef6da167497250af4ae0a5e2c853749ccecd4180ab42ab0272f953432` |
| `src-tauri/icons/Square30x30Logo.png` | `ed41cc429b49e7742c0b2359d78d24b4c8ed94febf719f89de91456cf4fe7138` |
| `src-tauri/icons/Square310x310Logo.png` | `1b023815019617c3ae5004276cb23f739c718c09378df8d46a966bde6262785d` |
| `src-tauri/icons/Square44x44Logo.png` | `8973e89884cd15791d209211dca1bf7d682979e10289d0efb65f78c2fee8ab63` |
| `src-tauri/icons/Square71x71Logo.png` | `b04e19a72d417a75d71aa7bf77c6ccb207f214940f8d153f496128ef4acf0e71` |
| `src-tauri/icons/Square89x89Logo.png` | `476ffc8b0e0e2dc5871688f6170e0754e516ce4119abdb5d8d3630e3acfe203f` |
| `src-tauri/icons/StoreLogo.png` | `df8b63239f284d12d0e92b3a8c6b55549f80ccc151300887acbae2cfcbf83cea` |

## Fonts

The two distributed WOFF2 files were obtained from Google Fonts on 2026-08-17 and were compared byte-for-byte with a fresh download on that date. Their embedded name records identify the upstream version and copyright holder. They remain under SIL Open Font License 1.1; the project GPL does not replace the font license.

| File | Upstream and version | License | SHA-256 |
| --- | --- | --- | --- |
| `src/assets/fonts/inter-latin.woff2` | Inter Project, Inter Regular 4.001, latin subset distributed by Google Fonts | SIL OFL-1.1; see `src/assets/fonts/OFL-Inter.txt` | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `src/assets/fonts/jetbrains-mono-latin.woff2` | JetBrains Mono Project, JetBrains Mono Regular 2.211, latin subset distributed by Google Fonts | SIL OFL-1.1; see `src/assets/fonts/OFL-JetBrainsMono.txt` | `83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be` |
| `src/assets/fonts/OFL-Inter.txt` | Inter Project license text | SIL OFL-1.1 | `5dd548d31a85f756e01d63e00d7faf1e324103ed3e9102fcbbabf2cc2db6dd39` |
| `src/assets/fonts/OFL-JetBrainsMono.txt` | JetBrains Mono Project license text | SIL OFL-1.1 | `b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d` |

Upstream projects:

- Inter: https://github.com/rsms/inter
- JetBrains Mono: https://github.com/JetBrains/JetBrainsMono
- Google Fonts distribution service: https://fonts.google.com/

## README screenshots

The screenshots were rendered on 2026-08-17 at 1280 x 720 from the local Input Panel Vite frontend, Rust development adapter, and `tests/fixtures/upstream/readme-screenshot-server.mjs`. All account, site, key, usage, subscription, and balance values originate from that deterministic fixture. Browser JPEG captures were decoded and re-encoded as true RGB PNG files with FFmpeg; the final PNG signature, dimensions, and pixel format were verified.

The screenshots are copyright xxxxxgold and distributed under GPL-3.0-only.

| File | Page | Privacy review | SHA-256 |
| --- | --- | --- | --- |
| `img/overview.png` | Overview | Synthetic account and usage data; no face, credential, token, or local path visible | `76a66bcab8f57218865d22c3048251137553ddd5649ed88c0fbee5231ed31663` |
| `img/keys.png` | Keys | Synthetic key names; raw keys are not returned or shown | `61e113f28dd01cb0c448bfb09958b76e1c757b4d5c9c8939006d52d5a27b2ecc` |
| `img/usage.png` | Usage | Synthetic request, model, token, and cost data; no IP address or user agent shown | `71d5f216da2f3988443ef192fa6d9cfc8c846fcfc6dac24b36eea36057d6389d` |
| `img/subscriptions.png` | Subscriptions | Synthetic plans, dates, quotas, and costs | `090b374fef617fc6d2a9149000c29c6a53fa09b7c1388526840073298076f934` |
| `img/system-settings.png` | System settings | The 720 px viewport excludes the lower database path section; no local path or personal data is visible | `8264feb2c40b12671e13dd1d06f1c6dfe3bd014b7e50980b23c5bfbfbf4677b5` |

## Privacy and rights conclusion

- No distributed first-party image uses a real person, recognizable likeness, third-party logo, or stock asset.
- No screenshot contains a real API key, JWT, private key, password, personal email, IP address, user-agent value, or visible local filesystem path.
- The former person-like branding assets and the unverified `manbo.mp3` sound are not part of this snapshot.
- First-party assets may be redistributed under GPL-3.0-only. The two font files and their license texts remain governed by SIL OFL-1.1.
