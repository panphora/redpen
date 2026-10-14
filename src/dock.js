// dock.js — every piece of chrome that is not the on-element box: the
// stylesheet, the bar in the corner, the one-line strip above it, the panel
// (list, resolved, orphans, menu, shortcuts), the undo toast, the hover peek,
// the theme probe, the keyboard and the click-away rule.
//
// One render() repaints all of it from the engine and the thread. It is a few
// dozen nodes, and it is the only way the dock ever changes.

import { mark, chrome } from './mark.js';
import { RUNNING } from './thread.js';
import { CANCELLABLE, turnLine, dotClass, firstLine, elementLabel, copyText } from './popover.js';
import { bevelIcon } from '@panphora/bevel/icons';

const CSS = `
  /* Bevel's look, scoped to redpen's own chrome. bevel.css itself is never
     loaded: it styles :root, body and .dark, which belong to the page under
     review. The values are Bevel's tokens, one set per theme, because the theme
     here comes from the probe below and not from the page's color-scheme. */
  @font-face { font-family: "redpen Plex Mono"; font-weight: 400; font-display: swap;
    src: local("IBM Plex Mono"), local("IBMPlexMono"),
      url(https://cdn.jsdelivr.net/npm/@panphora/bevel@0.1.1/fonts/ibm-plex-mono-latin-400-normal.woff2) format("woff2"); }
  @font-face { font-family: "redpen Plex Mono"; font-weight: 500; font-display: swap;
    src: local("IBM Plex Mono Medium"), local("IBMPlexMono-Medium"),
      url(https://cdn.jsdelivr.net/npm/@panphora/bevel@0.1.1/fonts/ibm-plex-mono-latin-500-normal.woff2) format("woff2"); }
  @font-face { font-family: "redpen Plex Mono"; font-weight: 600; font-display: swap;
    src: local("IBM Plex Mono SemiBold"), local("IBMPlexMono-SemiBold"),
      url(https://cdn.jsdelivr.net/npm/@panphora/bevel@0.1.1/fonts/ibm-plex-mono-latin-600-normal.woff2) format("woff2"); }

  .rpDock, .rprPop, .rprTip, .rpToast {
    --rp-ground: #FDF8F0; --rp-paper: #FFFCF6; --rp-sunk: #F4ECDF;
    --rp-ink: #2B241B; --rp-ink2: #4A4033; --rp-muted: #6B5942; --rp-faint: #9A8A70;
    --rp-line: #E8DCC6; --rp-line2: #D8C8AF; --rp-line3: #C4B192;
    --rp-brass: #8F6310; --rp-brass-soft: #F0E4CC;
    --rp-flag: #A83A2C; --rp-flag-soft: #F6DED6; --rp-ok: #256056;
    --rp-face: #F1E7D4; --rp-edge-hi: #FFF9ED; --rp-edge-lo: #D6C3A5;
    --rp-face-in: #E3D0B3; --rp-edge-in: #B89F7B; --rp-edge-in-hi: #F0E1C9;
    --rp-ox-face: #7A2A1F; --rp-ox-edge-hi: #AE4F3E; --rp-ox-edge-lo: #451510; --rp-ox-ink: #FBEEE8;
    --rp-shadow: 6px 6px 0 color-mix(in srgb, var(--rp-ink) 10%, transparent);
    --rp-mono: "redpen Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color-scheme: light;
  }
  [data-rp-theme="dark"].rpDock, [data-rp-theme="dark"].rprPop, [data-rp-theme="dark"].rprTip,
  [data-rp-theme="dark"].rpToast {
    --rp-ground: #0B0C13; --rp-paper: #11131E; --rp-sunk: #1A1D2C;
    --rp-ink: #ECEAF2; --rp-ink2: #C9CDE0; --rp-muted: #8A90AB; --rp-faint: #6A7090;
    --rp-line: #262B42; --rp-line2: #353B52; --rp-line3: #46506E;
    --rp-brass: #D9A445; --rp-brass-soft: #3A2F17;
    --rp-flag: #FF5566; --rp-flag-soft: #3A2226; --rp-ok: #63AE9E;
    --rp-face: #22273E; --rp-edge-hi: #3C4260; --rp-edge-lo: #1B2033;
    --rp-face-in: #28304D; --rp-edge-in: #1F2339; --rp-edge-in-hi: #4D587A;
    --rp-ox-face: #842E22; --rp-ox-edge-hi: #B85A47; --rp-ox-edge-lo: #3E1410; --rp-ox-ink: #FBEEE8;
    --rp-shadow: 6px 6px 0 rgba(0, 0, 0, .45);
    color-scheme: dark;
  }

  /* Scoped, never global: the mockup's bare [hidden] rule would reach into the
     page being reviewed. Buttons and textareas set their own display, which
     outranks the UA rule and would leave a "hidden" control on screen. */
  .rpDock [hidden], .rprPop [hidden], .rpDock[hidden], .rprPop[hidden] { display: none !important; }
  .rpDock *, .rprPop *, .rpToast * { box-sizing: border-box; }
  .rpDock :focus-visible, .rprPop :focus-visible, .rpToast :focus-visible {
    outline: 2px solid var(--rp-brass); outline-offset: 2px; }
  .rpDock svg, .rprPop svg { display: block; flex: none; }

  /* Bevel's raised button: light top and left, dark right and bottom, real
     borders so the corners mitre. Pressed, the edges swap. */
  .rpDock .rpExport button, .rprPop .rpPopFoot button, .rpDock .rpConfirm button.go,
  .rprPop .rpConfirm button.go {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    height: 26px; padding: 0 9px; font: 500 11.5px/1 var(--rp-mono); letter-spacing: .02em;
    color: var(--rp-ink); background: var(--rp-face); border: 2px solid;
    border-color: var(--rp-edge-hi) var(--rp-edge-lo) var(--rp-edge-lo) var(--rp-edge-hi);
    border-radius: 0; cursor: pointer; white-space: nowrap; }
  .rpDock .rpExport button:hover, .rprPop .rpPopFoot button:hover {
    background: color-mix(in srgb, var(--rp-face), var(--rp-edge-hi) 45%); }
  .rpDock .rpExport button:active:not([disabled]), .rprPop .rpPopFoot button:active,
  .rpDock .rpConfirm button.go:active, .rprPop .rpConfirm button.go:active {
    border-color: var(--rp-edge-lo) var(--rp-edge-hi) var(--rp-edge-hi) var(--rp-edge-lo); }
  /* primary: ink acts */
  .rpDock .rpExport .rpSend, .rpDock .rpExport.solid .rpCopy, .rprPop .rpPopFoot .rpRight {
    --rp-face: var(--rp-ink);
    --rp-edge-hi: color-mix(in srgb, var(--rp-ink), white 24%);
    --rp-edge-lo: color-mix(in srgb, var(--rp-ink), black 32%);
    color: var(--rp-ground); }
  .rpDock .rpExport .rpSend:hover, .rpDock .rpExport.solid .rpCopy:hover, .rprPop .rpPopFoot .rpRight:hover {
    background: color-mix(in srgb, var(--rp-ink), var(--rp-ground) 12%); }
  /* danger: ox destroys */
  .rpDock .rpConfirm button.go, .rprPop .rpConfirm button.go {
    --rp-face: var(--rp-ox-face); --rp-edge-hi: var(--rp-ox-edge-hi); --rp-edge-lo: var(--rp-ox-edge-lo);
    color: var(--rp-ox-ink); }
  .rpDock .rpConfirm button.go:hover, .rprPop .rpConfirm button.go:hover {
    background: color-mix(in srgb, var(--rp-ox-face), var(--rp-ox-edge-hi) 40%); }
  .rpDock .rpExport button[disabled] {
    --rp-face: var(--rp-sunk); --rp-edge-hi: var(--rp-paper); --rp-edge-lo: var(--rp-line2);
    color: var(--rp-faint); cursor: default; }
  .rpDock .rpExport button[disabled]:hover { background: var(--rp-sunk); }

  /* the dock */
  .rpDock { position: fixed; right: 14px; z-index: 99995; display: flex; flex-direction: column;
    align-items: stretch; gap: 8px; width: 330px;
    font: 12px/1.45 var(--rp-mono); letter-spacing: .02em; color: var(--rp-ink); }
  /* one class, so a host rule of equal specificity later in the cascade wins */
  .rprBar { bottom: 14px; }
  .rpDock .rpBar { display: flex; align-items: center; gap: 3px; align-self: flex-end;
    background: var(--rp-paper); border: 1px solid var(--rp-line2); border-radius: 0; padding: 4px;
    box-shadow: var(--rp-shadow); }
  .rpDock[data-mode] .rpBar { border-color: var(--rp-flag); }
  .rpDock.failed .rpBar { border-color: var(--rp-flag); }
  /* Bevel's flat icon button, pressed in when its mode is on */
  .rpDock .rpIcon { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
    border: 2px solid transparent; border-radius: 0; background: none; color: var(--rp-muted);
    cursor: pointer; padding: 0; }
  .rpDock .rpIcon:hover { background: var(--rp-sunk); color: var(--rp-ink); }
  .rpDock .rpIcon.on { background: var(--rp-face-in); color: var(--rp-flag);
    border-color: var(--rp-edge-in) var(--rp-edge-in-hi) var(--rp-edge-in-hi) var(--rp-edge-in); }
  .rpDock .rpIcon.on svg { translate: 1px 1px; }
  .rpDock .rpDiv { width: 1px; height: 20px; background: var(--rp-line2); margin: 0 3px; }
  .rpDock .rpList, .rpDock .rpMore, .rpDock .rprStep {
    font: inherit; letter-spacing: inherit; border: 0; background: none; height: 30px;
    color: var(--rp-muted); border-radius: 0; padding: 0 7px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; }
  .rpDock .rpList:hover, .rpDock .rpMore:hover, .rpDock .rprStep:hover { background: var(--rp-sunk); color: var(--rp-ink); }
  .rpDock .rpList { color: var(--rp-ink); font-weight: 500; font-variant-numeric: tabular-nums; gap: 3px; }
  .rpDock .rpCar { color: var(--rp-faint); display: inline-flex; }
  .rpDock .rpCar.open svg { rotate: 180deg; }
  .rpDock .rpList.on, .rpDock .rpMore.on { background: var(--rp-face-in); color: var(--rp-ink); }
  .rpDock .rpStepper { display: flex; align-items: center; }
  .rpDock .rprStep { padding: 0 4px; }
  .rpDock .rprCount { color: var(--rp-ink); padding: 0 2px; font-variant-numeric: tabular-nums; }
  .rpDock .rpWire { margin: 0 5px; cursor: pointer; }
  .rpDock .rpDot, .rprPop .rprDot { display: inline-block; width: 8px; height: 8px; border-radius: 0;
    flex: none; background: var(--rp-faint); }
  .rpDock .rpDot.working, .rprPop .rprDot.working { background: var(--rp-flag); animation: rpPulse 1.1s ease-in-out infinite; }
  .rpDock .rpDot.done, .rprPop .rprDot.done, .rpDock .rpDot.ok { background: var(--rp-ok); }
  .rpDock .rpDot.error, .rprPop .rprDot.error { background: var(--rp-flag); }
  .rpDock .rpDot.unsent { background: none; border: 1.5px solid var(--rp-faint); }
  @keyframes rpPulse { 0%, 100% { opacity: 1 } 50% { opacity: .4 } }

  /* the export: one button when there is no agent, two when there is */
  .rpDock .rpExport { display: inline-flex; gap: 4px; margin-left: 4px; }

  /* the strip: the minimized comment area, one line */
  .rpDock .rpStrip { display: flex; align-items: center; gap: 8px; background: var(--rp-paper);
    border: 1px solid var(--rp-line2); border-radius: 0; padding: 7px 9px; box-shadow: var(--rp-shadow);
    cursor: pointer; }
  .rpDock .rpStrip:hover { border-color: var(--rp-line3); }
  .rpDock .rpStrip .rpN { color: var(--rp-flag); font-weight: 600; flex: none; font-variant-numeric: tabular-nums; }
  .rpDock .rpStrip .rpSaid { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--rp-ink); }
  .rpDock .rpStrip .rpSaid.dim { color: var(--rp-faint); }
  .rpDock .rpStrip button { font: inherit; letter-spacing: inherit; border: 0; background: none;
    color: var(--rp-brass); border-radius: 0; padding: 2px 6px; cursor: pointer; flex: none; }
  .rpDock .rpStrip button:hover { background: var(--rp-sunk); }

  /* the mode hint */
  .rpDock .rpHint { align-self: flex-end; display: flex; align-items: center; gap: 8px;
    background: var(--rp-ink); color: var(--rp-ground); border-radius: 0; padding: 6px 10px;
    font-size: 11px; letter-spacing: .05em; box-shadow: var(--rp-shadow); }
  .rpDock .rpHint kbd { font: inherit; border: 1px solid color-mix(in srgb, var(--rp-ground) 40%, transparent);
    border-radius: 0; padding: 0 4px; opacity: .85; }

  /* the panel */
  .rpDock .rpPanel { background: var(--rp-paper); border: 1px solid var(--rp-line2); border-radius: 0;
    box-shadow: var(--rp-shadow); overflow: hidden; max-height: min(64vh, 440px);
    display: flex; flex-direction: column; }
  .rpDock .rpPhead { display: flex; align-items: center; gap: 8px; padding: 9px 11px;
    border-bottom: 1px solid var(--rp-line); font: 500 10.5px/1.4 var(--rp-mono); letter-spacing: .08em;
    text-transform: uppercase; color: var(--rp-muted); flex: none; }
  .rpDock .rpPhead .sp { flex: 1; }
  .rpDock .rpPhead button { font: inherit; letter-spacing: inherit; text-transform: inherit; border: 0;
    background: none; color: var(--rp-brass); cursor: pointer; border-radius: 0; padding: 2px 5px; }
  .rpDock .rpPhead button:hover { background: var(--rp-sunk); }
  .rpDock .rpPbody { overflow-y: auto; padding: 6px; }
  .rpDock .rpItem { display: flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left;
    border: 0; background: none; color: var(--rp-ink); font: inherit; letter-spacing: inherit;
    border-radius: 0; padding: 8px 9px; cursor: pointer; }
  .rpDock .rpItem:hover { background: var(--rp-sunk); }
  .rpDock .rpItem .n { color: var(--rp-flag); font-weight: 600; flex: none;
    font-variant-numeric: tabular-nums; min-width: 18px; }
  .rpDock .rpItem .said { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rpDock .rpItem .said.dim { color: var(--rp-faint); }
  .rpDock .rpItem .mini { flex: none; color: var(--rp-faint); font-size: 10.5px; }
  .rpDock .rpRow { display: flex; align-items: center; gap: 4px; }
  .rpDock .rpRow + .rpRow { border-top: 1px solid var(--rp-line); }
  .rpDock .rpRow .rpItem { flex: 1; }
  .rpDock .rpRow .sub { font: inherit; letter-spacing: inherit; border: 0; background: none;
    color: var(--rp-faint); border-radius: 0; padding: 5px 7px; cursor: pointer; flex: none; }
  .rpDock .rpRow .sub:hover { background: var(--rp-sunk); color: var(--rp-ink); }
  .rpDock .rpRow .sub.danger:hover { background: var(--rp-flag-soft); color: var(--rp-flag); }
  .rpDock .rpEmpty { padding: 18px 12px; color: var(--rp-faint); text-align: center; font-size: 11.5px; }
  .rpDock .rpNote { padding: 6px 11px 8px; color: var(--rp-faint); font-size: 11px; line-height: 1.5; }

  /* the menu: Bevel's popover menu */
  .rpDock .rpMenu { padding: 6px; }
  .rpDock .rpMenu button.mi { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    border: 0; background: none; color: var(--rp-ink); font: inherit; letter-spacing: inherit;
    border-radius: 0; padding: 8px 10px; cursor: pointer; }
  .rpDock .rpMenu button.mi:hover { background: var(--rp-sunk); }
  .rpDock .rpMenu button.mi .k { margin-left: auto; padding: 1px 5px; border: 1px solid var(--rp-line2);
    color: var(--rp-muted); font-size: 10px; }
  .rpDock .rpMenu button.mi.danger { color: var(--rp-flag); }
  .rpDock .rpMenu button.mi.danger:hover { background: var(--rp-flag-soft); }
  .rpDock .rpMenu button.mi[disabled] { color: var(--rp-faint); cursor: default; }
  .rpDock .rpMenu button.mi[disabled]:hover { background: none; }
  .rpDock .rpMenu .sep { height: 1px; background: var(--rp-line); margin: 5px 3px; }
  .rpDock .rpMenu .grp { padding: 8px 10px 4px; font: 500 10px/1.4 var(--rp-mono); letter-spacing: .08em;
    text-transform: uppercase; color: var(--rp-muted); }
  .rpDock .rpMenu .status { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
    color: var(--rp-muted); }
  .rpDock .rpMenu label.mi { display: flex; align-items: center; gap: 10px; padding: 6px 10px;
    cursor: pointer; border-radius: 0; }
  .rpDock .rpMenu label.mi:hover { background: var(--rp-sunk); }
  .rpDock .rpMenu label.mi input { accent-color: var(--rp-brass); margin: 0; }
  .rpDock .rpConfirm { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
    background: var(--rp-flag-soft); border-left: 2px solid var(--rp-flag); color: var(--rp-ink); }
  .rpDock .rpConfirm .sp { flex: 1; }
  .rpDock .rpConfirm button:not(.go) { font: inherit; letter-spacing: inherit; border: 0; border-radius: 0;
    padding: 4px 8px; cursor: pointer; background: none; color: var(--rp-muted); }
  .rpDock .rpConfirm button:not(.go):hover { color: var(--rp-ink); }
  .rpDock .rpKeys { padding: 4px 10px 10px; color: var(--rp-muted); font-size: 11px; line-height: 1.9; }
  .rpDock .rpKeys div { display: flex; gap: 10px; align-items: baseline; }
  .rpDock .rpKeys kbd { font: 500 10.5px/1.6 var(--rp-mono); border: 1px solid var(--rp-line2);
    border-bottom-width: 2px; border-radius: 0; background: var(--rp-sunk);
    padding: 0 5px; color: var(--rp-ink); flex: none; min-width: 74px; text-align: center; }
  .rpDock .rpWarn { padding: 9px 11px; background: var(--rp-flag-soft); color: var(--rp-flag);
    font-size: 11px; line-height: 1.5; border-bottom: 1px solid var(--rp-line); }

  /* the key letters, for the first eight seconds of every load */
  .rpDock.rpTeach .rpIcon { flex-direction: column; height: auto; padding: 4px 0 3px; }
  .rpDock.rpTeach .rpIcon::after { content: attr(data-key); font: 600 9px/1 var(--rp-mono);
    color: var(--rp-faint); margin-top: 2px; }

  /* the on-element popover */
  .rprPop { position: fixed; z-index: 99996; box-sizing: border-box; width: 352px;
    max-width: calc(100vw - 28px); background: var(--rp-paper); border: 1px solid var(--rp-line2);
    border-radius: 0; padding: 10px 12px 12px; box-shadow: var(--rp-shadow);
    font: 12.5px/1.5 var(--rp-mono); letter-spacing: .01em; color: var(--rp-ink); }
  .rprPop .rpPopTop { display: flex; align-items: center; gap: 2px; margin: 0 -4px 6px 0; cursor: move; }
  .rprPop .rprEyebrow { flex: 1; font: 500 10.5px/1.4 var(--rp-mono); letter-spacing: .08em; text-transform: uppercase;
    color: var(--rp-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rprPop .rprX { width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
    color: var(--rp-muted); background: none; border: 0; cursor: pointer; padding: 0; border-radius: 0; }
  .rprPop .rprX:hover { background: var(--rp-sunk); color: var(--rp-ink); }
  .rprPop .rpPopMenu { border: 1px solid var(--rp-line2); border-radius: 0; padding: 4px;
    margin-bottom: 10px; background: var(--rp-paper); box-shadow: var(--rp-shadow); }
  .rprPop .rpPopMenu button { display: flex; width: 100%; text-align: left; border: 0; background: none;
    font: inherit; letter-spacing: inherit; color: var(--rp-ink); border-radius: 0; padding: 7px 9px;
    cursor: pointer; }
  .rprPop .rpPopMenu button:hover { background: var(--rp-sunk); }
  .rprPop .rpPopMenu button.danger { color: var(--rp-flag); }
  .rprPop .rpPopMenu button.danger:hover { background: var(--rp-flag-soft); }
  .rprPop .rpConfirm { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
    background: var(--rp-flag-soft); border-left: 2px solid var(--rp-flag); color: var(--rp-ink); }
  .rprPop .rpConfirm .sp { flex: 1; }
  .rprPop .rpPopMenu .rpConfirm button { width: auto; }
  .rprPop .rpConfirm button:not(.go) { font: inherit; border: 0; border-radius: 0; padding: 3px 8px;
    cursor: pointer; background: none; color: var(--rp-muted); }
  .rprPop .rprQ { margin: 0 0 9px; }
  .rprPop .rprWas { margin: 0 0 8px; padding: 6px 9px; border-left: 2px solid var(--rp-brass);
    background: var(--rp-brass-soft); color: var(--rp-ink2); font-size: 11.5px; }
  .rprPop .rprWas b { display: block; font-weight: 500; letter-spacing: .08em; text-transform: uppercase;
    font-size: 9.5px; margin-bottom: 3px; color: var(--rp-brass); }
  .rprPop .rprStill { display: block; margin-top: 5px; font: inherit; color: var(--rp-brass);
    background: none; border: 0; border-bottom: 1px solid var(--rp-brass); border-radius: 0; padding: 0; cursor: pointer; }
  /* Bevel's textarea */
  .rprPop textarea { display: block; width: 100%; box-sizing: border-box; min-height: 78px; resize: vertical;
    font: inherit; color: var(--rp-ink); background: var(--rp-ground); border: 1px solid var(--rp-line2);
    border-radius: 0; padding: 8px 10px; outline: none; transition: border-color .14s; }
  .rprPop textarea::placeholder { color: var(--rp-faint); }
  .rprPop textarea:hover { border-color: var(--rp-faint); }
  .rprPop textarea:focus { outline: 2px solid var(--rp-brass); outline-offset: 1px; border-color: var(--rp-brass); }
  .rprPop .rpPopFoot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .rprPop .rpPopFoot .rprSpacer { flex: 1; }
  .rprPop .rprHint { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--rp-faint); }

  /* The thread. Your words are muted and the reply is full ink, because the
     reply is what you opened this to read. */
  .rprPop .rprThread { max-height: 38vh; overflow-y: auto; margin: 0 0 10px; }
  .rprPop .rprTurn + .rprTurn { border-top: 1px solid var(--rp-line); margin-top: 10px; padding-top: 10px; }
  .rprPop .rprWho { display: flex; align-items: baseline; gap: 8px; margin: 0 0 3px; font: 500 9.5px/1.4 var(--rp-mono);
    letter-spacing: .08em; text-transform: uppercase; color: var(--rp-muted); }
  .rprPop .rprWhen { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--rp-faint); }
  .rprPop .rprSaid, .rprPop .rprReply, .rprPop .rprMangled { margin: 0 0 6px; white-space: pre-wrap; }
  .rprPop .rprSaid { color: var(--rp-muted); }
  .rprPop .rprReply { color: var(--rp-ink); }
  .rprPop .rprMangled { color: var(--rp-flag); }
  .rprPop .rprTrail { margin: 0 0 6px; font-size: 11.5px; color: var(--rp-faint); }
  .rprPop .rprTrail summary { cursor: pointer; }
  .rprPop .rprTrail p { margin: 3px 0 0 12px; white-space: pre-wrap; }
  .rprPop .rprTurnState { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--rp-muted); }
  .rprPop .rprTurnState button { font: inherit; color: var(--rp-brass); background: none; border: 0;
    border-radius: 0; padding: 2px 6px; margin-left: auto; cursor: pointer; }
  .rprPop .rprTurnState button:hover { background: var(--rp-sunk); }
  .rprPop .rprNow { margin: 2px 0 0 15px; font-size: 11.5px; color: var(--rp-faint); }

  /* Bevel's tooltip */
  .rprTip { position: fixed; z-index: 99997; max-width: 320px; pointer-events: none;
    font: 11.5px/1.45 var(--rp-mono); color: var(--rp-ground); background: var(--rp-ink);
    border: 0; border-radius: 0; padding: 6px 9px; box-shadow: var(--rp-shadow); }

  /* the undo strip after something destructive: Bevel's toast */
  .rpToast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 99997;
    display: flex; align-items: center; gap: 12px; background: var(--rp-paper); color: var(--rp-ink);
    border: 1px solid var(--rp-line2); border-left: 3px solid var(--rp-ink); border-radius: 0;
    padding: 9px 12px; font: 12px/1 var(--rp-mono); letter-spacing: .02em; box-shadow: var(--rp-shadow); }
  .rpToast button { font: 500 12px/1 var(--rp-mono); letter-spacing: inherit; border: 0; background: none;
    color: var(--rp-brass); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; padding: 0; }

  /* Pointing is read off redpen's own dock, never off a class on the authored
     <body>: body's attributes changing makes the whole body a dirty root, so one
     click on comment mode would protect the entire page from the agent's own edit. */
  body:has(.rprBar[data-pointing]) main { outline: 1px solid var(--rp-flag, #A83A2C); outline-offset: 6px; }
`;

const BUBBLE = bevelIcon('comment', { size: 17 });
const SQUIGGLE = bevelIcon('pencil', { size: 17 });

const SHORTCUTS = [
  ['C', 'comment mode on / off'],
  ['D', 'draw mode on / off'],
  ['Esc', 'back out one step'],
  ['⌘↵', 'done, or send a follow-up'],
  ['⌘Z', 'undo the last stroke, in draw mode'],
  ['N', 'next unanswered question, when the page asks any'],
  ['?', 'this card'],
  ['shift-click', 'place a comment and stay in comment mode'],
];

const DARK = '(prefers-color-scheme: dark)';
const TYPING = 'input, textarea, select, [contenteditable]';
const INTERACTIVE = 'button, a, input, textarea, select, label, summary, [contenteditable], [role="button"]';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const isTyping = node =>
  (!!node && node.nodeType === 1 && (node.matches(TYPING) || node.isContentEditable)) || document.designMode === 'on';

let swatch = null;

// Any colour the page can compute, read back as sRGB bytes: Chromium hands an
// oklch() or color() background back unconverted, and the regex alone would
// leave such a page on the light palette.
function rgbBytes(css) {
  const m = /^rgba?\(([^)]+)\)$/.exec(css || '');
  if (m) {
    const [r, g, b, a = 1] = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    return a === 0 ? null : [r, g, b];
  }
  if (!swatch) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    swatch = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!swatch) return null;
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = 'rgba(0,0,0,0)';
  swatch.fillStyle = css;
  swatch.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = swatch.getImageData(0, 0, 1, 1).data;
  return a === 0 ? null : [r, g, b];
}

function luminance(css) {
  const rgb = rgbBytes(css);
  if (!rgb) return null;
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

// The page's own background, not a token it might not have: reading a host
// variable is what made the chrome cream on cream.
function isDark() {
  for (const node of [document.body, document.documentElement]) {
    if (!node) continue;
    const l = luminance(getComputedStyle(node).backgroundColor);
    if (l !== null) return l < 0.4;
  }
  return matchMedia(DARK).matches;
}

// What a marker says when you hover it. The comment's own words are the only
// thing that identifies it on the page.
function markerTitle(note) {
  const said = (note.text || '').trim();
  if (!said) return 'an empty comment';
  return said.length > 72 ? said.slice(0, 71) + '…' : said;
}

// Prepended, not appended: these are defaults a host is expected to override
// (where the dock sits, mostly), and mount() runs after the page's own <style>
// has been parsed. Appending would win every same-specificity tie and force the
// host into specificity games with its own review chrome.
function injectStyles() {
  if (document.getElementById('rpStyle')) return;
  const style = mark(el('style'));
  style.id = 'rpStyle';
  style.textContent = CSS;
  document.head.prepend(style);
}

export function createDock({ pen, thread, popover, prefs, tools, attr, clickThrough, keys, toggle, active = () => true, mountNode, step }) {
  injectStyles();

  let view = null;         // null | 'list' | 'resolved' | 'orphans' | 'menu' | 'shortcuts'
  let current = null;      // the comment the strip is reporting on
  let confirmAt = null;    // which row is asking
  let live = true;
  let toastNode = null, toastTimer = null;
  let clickThroughRule = null;

  // ---------- the dock ----------

  const root = chrome(el('div', 'rpDock rprBar'));
  root.dataset.rpTheme = 'light';

  const panel = el('div', 'rpPanel');
  panel.hidden = true;

  const strip = el('div', 'rpStrip');
  strip.hidden = true;
  const stripDot = el('span', 'rpDot rprDot');
  const stripN = el('span', 'rpN');
  const stripSaid = el('span', 'rpSaid');
  const stripAct = el('button', 'rpStripAct');
  stripAct.hidden = true;
  strip.append(stripDot, stripN, stripSaid, stripAct);

  const hint = el('div', 'rpHint');
  hint.hidden = true;

  const bar = el('div', 'rpBar');

  let commentBtn = null, drawBtn = null;
  if (tools.has('comment')) {
    commentBtn = el('button', 'rpIcon rpComment');
    commentBtn.dataset.key = 'C';
    commentBtn.title = 'Comment (C)';
    commentBtn.setAttribute('aria-label', 'Comment');
    commentBtn.innerHTML = BUBBLE;
    bar.appendChild(commentBtn);
  }
  if (tools.has('draw')) {
    drawBtn = el('button', 'rpIcon rpDraw');
    drawBtn.dataset.key = 'D';
    drawBtn.title = 'Draw (D)';
    drawBtn.setAttribute('aria-label', 'Draw');
    drawBtn.innerHTML = SQUIGGLE;
    bar.appendChild(drawBtn);
  }

  const div = el('span', 'rpDiv');
  const stepper = el('span', 'rpStepper');
  stepper.hidden = true;
  const prevBtn = el('button', 'rpPrev rprStep');
  prevBtn.innerHTML = bevelIcon('chevron-left', { size: 14 });
  prevBtn.setAttribute('aria-label', 'Previous');
  const countText = el('span', 'rpCount rprCount', '0/0');
  const nextBtn = el('button', 'rpNext rprStep');
  nextBtn.innerHTML = bevelIcon('chevron-right', { size: 14 });
  nextBtn.setAttribute('aria-label', 'Next');
  stepper.append(prevBtn, countText, nextBtn);

  const listBtn = el('button', 'rpList');
  const listN = el('span', 'rpListN', '0');
  const listCar = el('span', 'rpCar');
  listCar.innerHTML = bevelIcon('chevron-up', { size: 12 });
  listBtn.append(listN, listCar);

  const moreBtn = el('button', 'rpMore');
  moreBtn.innerHTML = bevelIcon('more', { size: 18 });
  moreBtn.title = 'More';
  moreBtn.setAttribute('aria-label', 'More');

  const wireDot = el('span', 'rpWire rpDot rprDot');
  wireDot.hidden = true;
  wireDot.title = 'the agent';

  const exportBox = el('span', 'rpExport');
  const sendBtn = el('button', 'rpSend', 'Send');
  sendBtn.hidden = true;
  const copyBtn = el('button', 'rpCopy', 'Copy JSON');
  exportBox.append(sendBtn, copyBtn);

  bar.append(div, stepper, listBtn, moreBtn, wireDot, exportBox);
  root.append(panel, strip, hint, bar);
  document.body.appendChild(root);

  const tip = chrome(el('div', 'rprTip'));
  tip.hidden = true;
  tip.dataset.rpTheme = 'light';
  document.body.appendChild(tip);

  // ---------- the theme ----------

  function applyTheme() {
    const v = isDark() ? 'dark' : 'light';
    root.dataset.rpTheme = v;
    tip.dataset.rpTheme = v;
    if (toastNode) toastNode.dataset.rpTheme = v;
    popover.theme(v);
  }

  const dark = matchMedia(DARK);
  const themeWatch = new MutationObserver(applyTheme);
  const watchTheme = node => {
    if (node) themeWatch.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  };
  watchTheme(document.documentElement);
  watchTheme(document.body);
  dark.addEventListener('change', applyTheme);
  window.addEventListener('load', applyTheme);
  applyTheme();

  // ---------- the undo toast ----------

  function hideToast() {
    clearTimeout(toastTimer);
    toastNode?.remove();
    toastNode = null;
  }

  function toast(text, undo) {
    hideToast();
    toastNode = chrome(el('div', 'rpToast'));
    toastNode.dataset.rpTheme = root.dataset.rpTheme;
    toastNode.appendChild(document.createTextNode(text));
    const back = el('button', null, 'undo');
    back.addEventListener('click', () => { undo?.(); hideToast(); render(); });
    toastNode.appendChild(back);
    document.body.appendChild(toastNode);
    toastTimer = setTimeout(hideToast, 8000);
  }

  // ---------- copy ----------

  // the resting label is captured once, not per call: two flashes inside the
  // window would otherwise restore each other's temporary text and stick
  const flashing = new Map();

  function flash(node, text) {
    clearTimeout(flashing.get(node)?.timer);
    flashing.set(node, { text, timer: setTimeout(() => { flashing.delete(node); render(); }, 1500) });
    render();
  }

  const labelOf = (node, resting) => (flashing.has(node) ? flashing.get(node).text : resting);

  function shape(out, which) {
    const copy = { ...out };
    if (which === 'comments') { delete copy.strokes; delete copy.viewBox; }
    if (which === 'drawing') {
      return {
        page: copy.page,
        ...(copy.coords ? { coords: copy.coords } : {}),
        ...(copy.viewBox ? { viewBox: copy.viewBox } : {}),
        ...(copy.targets ? { targets: copy.targets } : {}),
        strokes: copy.strokes || [],
      };
    }
    return copy;
  }

  const exportObject = (which = 'all') => shape(pen.review(), which);

  function copy(which = 'all') {
    popover.flush();
    const full = pen.review();
    const text = JSON.stringify(shape(full, which), null, 2);
    const said = which === 'drawing'
      ? `copied ✓ ${(full.strokes || []).length} strokes`
      : `copied ✓ ${full.answered} answers · ${full.items.filter(i => i.kind === 'comment').length} comments`;
    copyText(text, () => flash(copyBtn, said), () => flash(copyBtn, 'copy failed'));
    return text;
  }

  // ---------- modes ----------

  // Artwork is often covered by an element carrying pointer-events:none, so
  // elementsFromPoint never returns it and a drag across the picture files an
  // AREA note about the surrounding divs instead of a REGION note in fractions
  // of the picture. `clickThrough` names those elements.
  //
  // A stylesheet rule, not a loop over the nodes: the host may mount artwork
  // lazily, so a snapshot taken when the mode starts misses everything that
  // scrolls in afterwards.
  if (clickThrough) {
    clickThroughRule = mark(el('style'));
    clickThroughRule.id = 'rprClickThrough';
    clickThroughRule.textContent = `body:has(.rprBar[data-pointing]) ${clickThrough} { pointer-events: auto !important; }`;
    document.head.appendChild(clickThroughRule);
  }

  // The rule can stop working silently: the inline style may be written by a
  // generated file, and the day it moves into a class of its own the specificity
  // changes underneath us.
  function assertClickThrough() {
    if (!clickThrough) return;
    for (const node of document.querySelectorAll(clickThrough)) {
      const r = node.getBoundingClientRect();
      if (!r.width || r.top > innerHeight || r.bottom < 0) continue;
      const x = r.left + r.width / 2, y = Math.max(1, Math.min(innerHeight - 1, r.top + r.height / 2));
      if (!document.elementsFromPoint(x, y).includes(node)) {
        console.warn('[redpen] ' + clickThrough + ' is still not hit-testable: a drag on it will file an area note, not a region of the picture', node);
      }
      return;
    }
  }

  function setMode(v) {
    if (v) popover.leave();
    pen.setMode(v);
    if (v === 'note') assertClickThrough();
    render();
  }

  const toggleMode = m => setMode(pen.mode() === m ? null : m);

  function setView(v) {
    view = v;
    confirmAt = null;
    render();
  }

  // ---------- rendering ----------

  function runningAt() {
    for (const note of pen.items()) {
      for (const turn of note.thread || []) {
        if (RUNNING.has(turn.state)) return { note, turn };
      }
    }
    return null;
  }

  const openComments = () => pen.items().filter(n => !n.resolved);
  const resolvedComments = () => pen.items().filter(n => n.resolved);

  function render() {
    if (!live) return;
    if (current != null) {
      const note = pen.items().find(n => n.id === current);
      if (!note || note.resolved) current = null;
    }
    const run = runningAt();
    pen.working(run ? run.note.id : null);
    const mode = pen.mode();
    root.classList.toggle('failed', pen.saveFailed());
    if (mode) root.dataset.mode = mode; else delete root.dataset.mode;
    root.toggleAttribute('data-pointing', mode === 'note');
    commentBtn?.classList.toggle('on', mode === 'note');
    drawBtn?.classList.toggle('on', mode === 'draw');

    const requests = pen.requests();
    stepper.hidden = !requests.length;
    countText.textContent = labelOf(countText, requests.filter(r => r.answered).length + '/' + requests.length);

    listN.textContent = String(openComments().length);
    listCar.classList.toggle('open', view === 'list');
    listBtn.classList.toggle('on', !!view);
    moreBtn.classList.toggle('on', view === 'menu');

    const connected = thread.connected();
    wireDot.hidden = !connected;
    wireDot.classList.toggle('working', thread.busy());

    const p = thread.pending();
    sendBtn.hidden = !connected;
    exportBox.classList.toggle('solid', !connected);
    if (connected) {
      sendBtn.textContent = labelOf(sendBtn, p.count ? 'Send ' + p.count : 'Send');
      sendBtn.disabled = !p.count || !pen.loaded();
      copyBtn.textContent = labelOf(copyBtn, '⧉');
      copyBtn.title = 'Copy JSON';
    } else {
      copyBtn.textContent = labelOf(copyBtn, 'Copy JSON');
      copyBtn.removeAttribute('title');
    }

    renderHint(mode);
    renderStrip(p);
    renderPanel();
  }

  function renderHint(mode) {
    hint.hidden = !mode;
    if (!mode) return;
    hint.textContent = '';
    if (mode === 'note') {
      hint.append(document.createTextNode('click or drag an element'), el('kbd', null, 'esc'));
    } else {
      hint.append(document.createTextNode('drag to draw'), el('kbd', null, '⌘Z'),
        document.createTextNode('undo'), el('kbd', null, 'esc'));
    }
  }

  function renderStrip(p) {
    if (view) { strip.hidden = true; return; }
    const run = runningAt();
    const note = run ? run.note : (current == null ? null : pen.items().find(n => n.id === current && !n.resolved));
    if (!note) { strip.hidden = true; return; }
    strip.hidden = false;
    stripN.textContent = '#' + note.id;
    if (run) {
      stripDot.hidden = false;
      stripDot.className = 'rpDot rprDot working';
      stripSaid.className = 'rpSaid';
      const trail = run.turn.progress;
      stripSaid.textContent = (trail && trail.length ? trail[trail.length - 1] : turnLine(run.turn)) || '';
      const can = CANCELLABLE.has(run.turn.state) && typeof thread.transport()?.cancel === 'function';
      stripAct.hidden = !can;
      stripAct.textContent = 'cancel';
      stripAct.onclick = e => { e.stopPropagation(); thread.transport().cancel(run.turn.request); };
    } else {
      const turns = note.thread || [];
      const last = turns[turns.length - 1] || null;
      const unsent = thread.connected() && (p.comments.includes(note.id) || p.drafts.includes(note.id));
      stripDot.hidden = !last && !unsent;
      stripDot.className = 'rpDot rprDot ' + (unsent ? 'unsent' : (last ? dotClass(last.state) : ''));
      const empty = !String(note.text || '').trim();
      stripSaid.className = 'rpSaid' + (empty ? ' dim' : '');
      stripSaid.textContent = (unsent ? 'unsent · ' : '') + firstLine(note.text);
      stripAct.hidden = true;
      stripAct.onclick = null;
    }
    strip.onclick = () => openComment(note.id);
  }

  // ---------- the panel ----------

  function head(title, rights) {
    const h = el('div', 'rpPhead');
    h.appendChild(document.createTextNode(title));
    h.appendChild(el('span', 'sp'));
    for (const r of rights || []) if (r) h.appendChild(r);
    const x = el('button', null, 'close');
    x.addEventListener('click', () => setView(null));
    h.appendChild(x);
    panel.appendChild(h);
    return h;
  }

  function body(cls) {
    const b = el('div', 'rpPbody' + (cls ? ' ' + cls : ''));
    panel.appendChild(b);
    return b;
  }

  function headBtn(text, fn) {
    const b = el('button', null, text);
    b.addEventListener('click', fn);
    return b;
  }

  function renderPanel() {
    if (!view) { panel.hidden = true; panel.textContent = ''; return; }
    panel.hidden = false;
    panel.textContent = '';
    if (view === 'menu') return renderMenu();
    if (view === 'resolved') return renderResolved();
    if (view === 'orphans') return renderOrphans();
    if (view === 'shortcuts') return renderShortcuts();
    renderList();
  }

  function renderList() {
    const list = openComments();
    const retired = resolvedComments().length;
    const orphaned = pen.orphans().length;
    head(list.length + (list.length === 1 ? ' comment' : ' comments'), [
      retired ? headBtn(retired + ' resolved', () => setView('resolved')) : null,
      orphaned ? headBtn(orphaned + ' orphaned', () => setView('orphans')) : null,
    ]);
    const b = body();
    if (!list.length) {
      b.appendChild(el('div', 'rpEmpty', 'No comments yet. Press C, then click anything on the page.'));
      return;
    }
    const p = thread.pending();
    for (const note of [...list].reverse()) {
      const row = el('div', 'rpRow');
      const item = el('button', 'rpItem');
      const empty = !String(note.text || '').trim();
      const said = el('span', 'said' + (empty ? ' dim' : ''), firstLine(note.text));
      const turns = note.thread || [];
      const running = turns.some(t => RUNNING.has(t.state));
      const unsent = thread.connected() && (p.comments.includes(note.id) || p.drafts.includes(note.id));
      let mini;
      if (running) mini = '···';
      else if (note.unread) mini = '● reply';
      else if (unsent) mini = 'unsent';
      else if (turns.length) mini = turns.length + '↩';
      else mini = elementLabel(note.target, note.kind);
      item.append(el('span', 'n', '#' + note.id), said, el('span', 'mini', mini));
      item.addEventListener('click', () => openComment(note.id));
      const drop = el('button', 'sub danger', '×');
      drop.title = 'delete comment ' + note.id;
      drop.addEventListener('click', () => removeComment(note.id));
      row.append(item, drop);
      row.addEventListener('mouseenter', () => pen.highlight(note.id));
      row.addEventListener('mouseleave', () => pen.highlight(null));
      b.appendChild(row);
    }
  }

  // Mirrors the orphan list exactly, and for the same reason: these are the
  // reviewer's own words, and the only way one ever leaves is a click on discard.
  function renderResolved() {
    const list = resolvedComments();
    head(list.length + ' resolved', [headBtn('‹ open', () => setView('list'))]);
    const b = body();
    if (!list.length) {
      b.appendChild(el('div', 'rpEmpty', 'Nothing retired yet.'));
      return;
    }
    for (const note of list) {
      if (confirmAt === 'resolved:' + note.id) {
        b.appendChild(confirmRow(`Delete comment ${note.id}?`, () => {
          pen.remove(note.id);
          if (!resolvedComments().length) view = 'list';
          setView(view);
        }));
        continue;
      }
      const row = el('div', 'rpRow');
      const item = el('button', 'rpItem');
      item.append(el('span', 'n', '#' + note.id), el('span', 'said dim', firstLine(note.text)));
      item.addEventListener('click', () => { thread.resolve(note.id, false); setView(null); openComment(note.id); });
      const back = el('button', 'sub', 'reopen');
      back.addEventListener('click', () => { thread.resolve(note.id, false); setView(null); openComment(note.id); });
      const drop = el('button', 'sub danger', 'discard');
      drop.addEventListener('click', () => { confirmAt = 'resolved:' + note.id; render(); });
      row.append(item, back, drop);
      b.appendChild(row);
    }
  }

  // The orphan list is the whole reason answers store their question. These are
  // words written against a question the page no longer asks.
  function renderOrphans() {
    const list = pen.orphans();
    head(list.length + ' orphaned', [headBtn('‹ open', () => setView('list'))]);
    panel.appendChild(el('div', 'rpNote', 'answers to questions the page no longer asks. They still export.'));
    const b = body();
    for (const o of list) {
      const row = el('div', 'rpRow');
      const item = el('button', 'rpItem');
      item.append(el('span', 'said dim', o.askedWas || o.key), el('span', 'mini', firstLine(o.answer)));
      const drop = el('button', 'sub danger', 'discard');
      drop.addEventListener('click', () => {
        pen.answer(o.key, '');
        if (!pen.orphans().length) view = 'list';
        setView(view);
      });
      row.append(item, drop);
      b.appendChild(row);
    }
  }

  function renderShortcuts() {
    head('shortcuts', [headBtn('‹ open', () => setView('list'))]);
    const b = body();
    const keysBox = el('div', 'rpKeys');
    const shortcuts = toggle ? [[toggle, 'show or hide redpen'], ...SHORTCUTS] : SHORTCUTS;
    for (const [k, said] of shortcuts) {
      const line = el('div');
      line.append(el('kbd', null, k), el('span', null, said));
      keysBox.appendChild(line);
    }
    b.appendChild(keysBox);
  }

  function mi(text, right, fn, danger) {
    const b = el('button', 'mi' + (danger ? ' danger' : ''));
    b.appendChild(document.createTextNode(text));
    if (right != null) b.appendChild(el('span', 'k', String(right)));
    b.addEventListener('click', fn);
    return b;
  }

  function confirmRow(text, go) {
    const row = el('div', 'rpConfirm');
    row.append(document.createTextNode(text), el('span', 'sp'));
    const no = el('button', null, 'cancel');
    no.addEventListener('click', () => { confirmAt = null; render(); });
    const yes = el('button', 'go', 'delete');
    yes.addEventListener('click', () => { confirmAt = null; go(); });
    row.append(no, yes);
    return row;
  }

  function renderMenu() {
    head('');
    if (pen.saveFailed()) {
      panel.appendChild(el('div', 'rpWarn',
        'Not saving. These comments only exist in this tab. Copy JSON before you close it.'));
    }
    const b = body('rpMenu');

    b.appendChild(mi('Copy JSON', null, () => { copy('all'); setView(null); }));
    b.appendChild(mi('Copy comments only', null, () => { copy('comments'); setView(null); }));
    b.appendChild(mi('Copy drawing only', null, () => { copy('drawing'); setView(null); }));

    if (thread.connected()) {
      b.appendChild(el('div', 'sep'));
      const label = el('label', 'mi');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = !prefs.hold();
      box.addEventListener('change', () => { prefs.setHold(!box.checked); render(); });
      label.append(box, document.createTextNode('Send comments as I finish them'));
      b.appendChild(label);
    }

    b.appendChild(el('div', 'sep'));
    b.appendChild(mi('Shortcuts', '?', () => setView('shortcuts')));

    const status = el('div', 'status');
    if (thread.connected()) status.append(el('span', 'rpDot ok'), document.createTextNode('agent connected'));
    else status.append(document.createTextNode('no agent on this page'));
    b.appendChild(status);

    b.appendChild(el('div', 'sep'));
    const comments = pen.items().length;
    const strokes = pen.strokes().length;
    if (confirmAt === 'comments') {
      b.appendChild(confirmRow(`Delete ${comments} comment${comments === 1 ? '' : 's'}?`, () => pen.clearNotes()));
    } else {
      const row = mi('Clear all comments…', comments, () => { confirmAt = 'comments'; render(); }, true);
      row.disabled = !comments;
      b.appendChild(row);
    }
    if (confirmAt === 'ink') {
      b.appendChild(confirmRow(`Delete ${strokes} stroke${strokes === 1 ? '' : 's'}?`, () => pen.clearStrokes()));
    } else {
      const row = mi('Clear all ink…', strokes, () => { confirmAt = 'ink'; render(); }, true);
      row.disabled = !strokes;
      b.appendChild(row);
    }
  }

  // ---------- comments ----------

  function openComment(id) {
    const note = pen.items().find(n => n.id === id);
    if (!note) return;
    current = id;
    setView(null);
    popover.openComment(note);
  }

  function removeComment(id) {
    const note = pen.items().find(n => n.id === id);
    if (!note) return;
    popover.closeIf(id);
    pen.remove(id);
    render();
    toast(`comment ${id} deleted`, () => pen.restore([note]));
  }

  // ---------- the hover peek ----------

  // Guarded, because `hidden = true` writes the attribute whether or not it
  // changed, and this runs on every pointer transition across the page. On a
  // host that reads redpen's marking those records are dropped at intake; on one
  // that does not, moving the mouse would trigger an autosave.
  function hideTip() {
    if (!tip.hidden) tip.hidden = true;
  }

  // The ask used to be copied onto the page's own question elements as
  // data-tooltip, so whatever tooltip library the page already loads would show
  // it. That writes an attribute onto an AUTHORED node: it reaches the saved
  // file, and it makes every question element a dirty root that scoped live-sync
  // then protects from the agent's own edit. redpen renders the preview itself,
  // reading the ask straight off the page's attribute and writing nothing back.
  function showTip(node) {
    const text = node.dataset.tooltip ? '' : node.getAttribute(attr);
    if (!text) return hideTip();
    tip.textContent = text;
    tip.hidden = false;
    // Measured after it is filled and visible, or the flip below reads a height
    // of zero and never flips.
    const r = node.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const above = r.top - t.height - 8;
    tip.style.left = Math.max(8, Math.min(r.left, innerWidth - t.width - 8)) + 'px';
    tip.style.top = (above < 8 ? r.bottom + 8 : above) + 'px';
  }

  function showPeek(node, text) {
    tip.textContent = text;
    tip.hidden = false;
    const r = node.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let left = r.right + 8;
    if (left + t.width > innerWidth - 8) left = Math.max(8, r.left - t.width - 8);
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, Math.min(r.top, innerHeight - t.height - 8)) + 'px';
  }

  // One handler for both showing and hiding: pointing at anything that is not a
  // question is the ordinary way a preview ends. While the capture overlay is up
  // every event targets the overlay, so comment mode hides it for free.
  const onHover = e => {
    if (e.target && e.target.closest && e.target.closest('.laMarkers')) return;
    const node = e.target && e.target.closest ? e.target.closest('[' + attr + ']') : null;
    node ? showTip(node) : hideTip();
  };

  const onMarkerHover = e => {
    const hit = e.target && e.target.closest ? e.target.closest('[data-la-note]') : null;
    if (!hit) return hideTip();
    const note = pen.items().find(n => n.id === Number(hit.dataset.laNote));
    if (!note) return hideTip();
    showPeek(hit, markerTitle(note));
  };

  document.addEventListener('mouseover', onHover);
  document.addEventListener('focusin', onHover);
  // The bubble is position:fixed and placed once, so a scroll leaves it pointing
  // at where the question used to be.
  window.addEventListener('scroll', hideTip, true);

  const markerLayer = (mountNode || document).querySelector('.laMarkers');
  markerLayer?.addEventListener('mouseover', onMarkerHover);
  markerLayer?.addEventListener('mouseout', hideTip);

  // ---------- the keyboard ----------

  function onKey(e) {
    if (!active()) return;
    const typing = isTyping(e.target) || isTyping(document.activeElement);
    if (e.key === 'Escape') {
      if (view) return setView(null);
      if (popover.isOpen()) return popover.cancel();
      if (pen.mode()) return setMode(null);
      return;
    }
    if (typing) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && popover.isOpen()) { e.preventDefault(); popover.finish(); }
      return;
    }
    // bare letters only: cmd-P is print and cmd-N is a new window, and stealing
    // either leaves the page in a mode behind the dialog
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && pen.mode() === 'draw') {
        e.preventDefault();
        pen.undoStroke();
      }
      return;
    }
    if (e.key === 'c' && tools.has('comment')) return toggleMode('note');
    if (e.key === 'd' && tools.has('draw')) return toggleMode('draw');
    if (e.key === 'n' && pen.requests().length) return step(1);
    if (e.key === '?') return setView(view === 'shortcuts' ? null : 'shortcuts');
  }

  if (keys) window.addEventListener('keydown', onKey);

  // ---------- click-away ----------

  // The click is never stopped: the page gets it too. The capture overlay is
  // [data-la-ui], so a shift-click burst never falls through here.
  function onPointerDown(e) {
    if (view && !e.target.closest('.rpDock')) setView(null);
    if (!popover.isOpen()) return;
    if (e.target.closest('[data-la-ui]')) return;
    if (e.target.closest(INTERACTIVE)) return;
    popover.leave();
  }

  document.addEventListener('pointerdown', onPointerDown, true);

  // ---------- wiring ----------

  commentBtn?.addEventListener('click', () => toggleMode('note'));
  drawBtn?.addEventListener('click', () => toggleMode('draw'));
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  listBtn.addEventListener('click', () => setView(view === 'list' ? null : 'list'));
  moreBtn.addEventListener('click', () => setView(view === 'menu' ? null : 'menu'));
  copyBtn.addEventListener('click', () => copy('all'));
  sendBtn.addEventListener('click', () => {
    // The box goes first: what is open flushes (and in hold mode joins the
    // pending set), and a box left open over a sent comment would keep editing
    // an opening message the agent already has.
    popover.leave();
    const want = thread.pending().count;
    const started = thread.sendPending();
    if (!started && want) flash(sendBtn, 'not sent, copy instead');
    render();
  });
  wireDot.addEventListener('click', () => {
    const run = runningAt();
    if (run) return openComment(run.note.id);
    setView(view === 'list' ? null : 'list');
  });

  pen.addEventListener('mode', render);
  pen.addEventListener('change', e => {
    const d = e.detail || {};
    if (d.action === 'note' && d.item) current = d.item.id;
    if (d.action === 'add' && d.item) current = d.item.id;
    if (d.action === 'load') {
      const open = openComments();
      current = open.length ? open[open.length - 1].id : null;
    }
  });
  pen.addEventListener('item:add', e => {
    if (!e.detail.sticky) pen.setMode(null);
    current = e.detail.item.id;
    popover.openComment(e.detail.item, { fresh: true });
    render();
  });
  pen.addEventListener('item:click', e => {
    current = e.detail.item.id;
    popover.openComment(e.detail.item);
    render();
  });
  pen.addEventListener('request:click', e => popover.openAsk(e.detail.request.key));

  root.classList.add('rpTeach');
  const teachTimer = setTimeout(() => root.classList.remove('rpTeach'), 8000);

  return {
    node: root,
    render,
    setMode,
    setView,
    toast,
    copy,
    exportObject,
    flashCount: text => flash(countText, text),
    destroy() {
      live = false;
      clearTimeout(teachTimer);
      for (const { timer } of flashing.values()) clearTimeout(timer);
      flashing.clear();
      hideToast();
      if (keys) window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mouseover', onHover);
      document.removeEventListener('focusin', onHover);
      window.removeEventListener('scroll', hideTip, true);
      window.removeEventListener('load', applyTheme);
      dark.removeEventListener('change', applyTheme);
      themeWatch.disconnect();
      markerLayer?.removeEventListener('mouseover', onMarkerHover);
      markerLayer?.removeEventListener('mouseout', hideTip);
      clickThroughRule?.remove();
      clickThroughRule = null;
      root.remove();
      tip.remove();
    },
  };
}
