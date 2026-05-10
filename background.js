// ─────────────────────────────────────────────────────────────────────────────
// CousinsWatch PRO — Background service worker (MV3)
//
// Responsibilities:
//   • Open the popup window when the toolbar icon is clicked
//   • Track the popup window id so we can focus it from the popup itself
//   • Relay focus requests from the popup
//
// Hardening:
//   • All chrome.runtime.onMessage handlers verify sender.id and sender.url
//     belong to this extension before acting (defense-in-depth even though
//     externally_connectable is not declared).
// ─────────────────────────────────────────────────────────────────────────────

let popupWindowId = null;

const POPUP_WIDTH = 420;
const POPUP_HEIGHT = 740;

chrome.runtime.onInstalled.addListener(() => {
  console.log('[CW] CousinsWatch installed / updated.');
});

chrome.action.onClicked.addListener(() => {
  if (popupWindowId !== null) {
    chrome.windows.get(popupWindowId, (win) => {
      if (chrome.runtime.lastError || !win) {
        openPopupWindow();
      } else {
        chrome.windows.update(popupWindowId, { focused: true });
      }
    });
  } else {
    openPopupWindow();
  }
});

function openPopupWindow() {
  chrome.windows.create(
    {
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      focused: true,
    },
    (win) => {
      if (!win) {
        console.warn('[CW] window.create returned null', chrome.runtime.lastError);
        return;
      }
      popupWindowId = win.id;
      const onRemoved = (id) => {
        if (id === popupWindowId) {
          popupWindowId = null;
          chrome.windows.onRemoved.removeListener(onRemoved);
        }
      };
      chrome.windows.onRemoved.addListener(onRemoved);
    }
  );
}

/**
 * Reject any onMessage that doesn't originate from this extension's own
 * pages (popup). Web pages cannot send chrome.runtime messages without
 * `externally_connectable`, but we double-check as defense-in-depth.
 */
function isTrustedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(''))) return false;
  return true;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!isTrustedSender(sender)) {
    console.warn('[CW] dropped message from untrusted sender', sender);
    return;
  }
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    return;
  }

  if (message.type === 'COUSINS_BACKGROUND_LOG') {
    console.log('[CW background]', message.data);
    return;
  }

  if (message.type === 'FOCUS_POPUP') {
    if (popupWindowId !== null) {
      chrome.windows.update(popupWindowId, { focused: true }, () => {
        if (chrome.runtime.lastError) console.warn('[CW] focus popup failed', chrome.runtime.lastError);
      });
    }
    return;
  }

  if (message.type === 'REGISTER_POPUP' && Number.isInteger(message.windowId)) {
    popupWindowId = message.windowId;
    return;
  }
});
