# Universal Video Maximizer (Enhanced)

One hotkey turns any web video into a clean, full-screen cinema view. No clutter, no
distractions, no floating buttons sitting on your screen when you are not using it.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`UniversalVideoMaximizer.user.js`](UniversalVideoMaximizer.user.js) and click **Raw** — your manager will offer to install it.
3. Open any page with a video and press **Ctrl + F11**.

Or install from [Greasy Fork](https://greasyfork.org/en/scripts/560411-universal-video-maximizer-enhanced).

## Features

- **Modern player UI** — glassmorphism blur, smooth animations, orange gradient accents.
- **Smart detection** — finds the page's main video and ignores sidebar ads, tiny sticky
  players and tracking pixels. Full shadow DOM support.
- **Invisible until you ask** — nothing is drawn on the page until you hit the hotkey.
- **Power controls** — custom volume slider, scrubbing, and speed up to 4.0x.
- **VK / vkvideo.ru handled natively**, and SPA playlist navigation no longer breaks it.
- Volume and speed are remembered between videos.

## Controls

| Action | Shortcut |
|---|---|
| Toggle cinema mode | **Ctrl + F11** |
| Play / pause | **Space**, or click the centre |
| Exit | **Esc**, **Q**, or the *Exit* button |
| Change speed | Click the speed text to cycle 0.25x → 1.0x → 2.0x → 3.0x → 4.0x |

## Notes

Works on standard HTML5 `<video>` elements everywhere, and also attempts to maximize generic
`<iframe>` embeds.

## Applies to

All sites.

## License

MIT — see [LICENSE](LICENSE).
