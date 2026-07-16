







/**
 * Enthält alle Low-Level Interaktionen mit dem Webview (DOM Manipulation).
 * Dies trennt die "Browser-Steuerung" von der React-App-Logik.
 */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const determineAlbumName = async (webview: any): Promise<string | null> => {
    return null;
};

export const extractIdFromUrl = async (webview: any): Promise<string> => {
    const script = `(function() {
        const match = window.location.href.match(/photo\\/([^?#]+)/);
        return match ? match[1] : window.location.href;
    })()`;
    try {
        return await webview.executeJavaScript(script);
    } catch(e) { return ""; }
};

export const navigateNext = async (webview: any): Promise<void> => {
    await webview.executeJavaScript(`
      (() => {
           document.body.focus();
           document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, bubbles: true }));
      })();
    `);
};

export const navigatePrevious = async (webview: any): Promise<void> => {
    await webview.executeJavaScript(`
      (() => {
           document.body.focus();
           document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, bubbles: true }));
      })();
    `);
};

export const triggerDownloadKeys = async (webview: any): Promise<void> => {
    await webview.executeJavaScript(`
        (() => {
            if (document.activeElement) document.activeElement.blur();
            document.body.focus();
            
            const eventConfig = { 
                key: 'D', code: 'KeyD', keyCode: 68, which: 68, 
                shiftKey: true, bubbles: true, cancelable: true, view: window 
            };
            document.body.dispatchEvent(new KeyboardEvent('keydown', eventConfig));
            document.body.dispatchEvent(new KeyboardEvent('keypress', eventConfig));
            document.body.dispatchEvent(new KeyboardEvent('keyup', eventConfig));
        })();
    `);
};

export const toggleInfoPanel = async (webview: any): Promise<void> => {
    await webview.executeJavaScript(`
      (() => {
          // "Dummes" Toggling: Einfach 'i' senden, keine Logik.
          if (document.activeElement) document.activeElement.blur();
          document.body.focus();
          
          const eventConfig = { 
              key: 'i', code: 'KeyI', keyCode: 73, which: 73, 
              bubbles: true, cancelable: true, view: window 
          };
          document.body.dispatchEvent(new KeyboardEvent('keydown', eventConfig));
          document.body.dispatchEvent(new KeyboardEvent('keypress', eventConfig));
          document.body.dispatchEvent(new KeyboardEvent('keyup', eventConfig));
      })();
    `);
};

export const killVideoPlayers = async (webview: any): Promise<void> => {
    const script = `
      (() => {
          // 1. Video Tags finden und stoppen
          const videos = document.querySelectorAll('video');
          videos.forEach(v => {
              if (!v.paused) v.pause();
              // Wir setzen src nicht auf leer, da das manchmal den GPhotos Viewer crashen lässt,
              // aber wir pausieren aggressiv.
              v.muted = true;
          });
          return true;
      })();
    `;
    try { await webview.executeJavaScript(script); } catch(e) {}
};

export const extractCurrentImageInfo = async (webview: any): Promise<{id: string, dateStr: string, foundInSidePanel: boolean, potentialFilename?: string}> => {
    const script = `
      (async () => {
          const browserUrl = window.location.href;
          const match = browserUrl.match(/photo\\/([^?#]+)/);
          const id = match ? match[1] : browserUrl;

          // --- Metadaten Scan (Sidebar) ---
          const thresholdX = window.innerWidth * 0.7; 
          const allElements = document.querySelectorAll('*');
          let collectedText = [];
          let potentialFilename = null;

          for (const el of allElements) {
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              
              // Nur Elemente rechts (typischerweise Sidebar)
              if (rect.left >= thresholdX) {
                  const label = el.getAttribute('aria-label');
                  if (label) collectedText.push(label);

                  if (['DIV', 'SPAN', 'P', 'H1', 'H2', 'H3', 'TIME'].includes(el.tagName)) {
                      const txt = el.innerText;
                      if (txt && txt.trim().length > 0 && txt.length < 200) {
                           collectedText.push(txt);
                           
                           // Einfache Heuristik für Dateiname: 
                           // Regex UPDATE: Erlaubt jetzt auch Punkte (.) innerhalb des Namens (z.B. GOPR.MP4.jpg)
                           // Alte Regex war: /^[a-zA-Z0-9_\\-\\(\\)\\s]+\\.(JPG|...
                           if (!potentialFilename && txt.match(/^[a-zA-Z0-9_\\-\\(\\)\\s\\.]+\\.(JPG|JPEG|PNG|MP4|MOV|HEIC|GIF|AVI|M4V|WEBP)$/i)) {
                               potentialFilename = txt.trim();
                           }
                      }
                  }
                  if (el.tagName === 'INPUT' && el.value) {
                      collectedText.push(el.value);
                      // Ein Input Feld in der Sidebar ist oft der Titel/Dateiname
                      if (!potentialFilename && el.value.match(/\\.[a-zA-Z0-9]{3,4}$/)) {
                           potentialFilename = el.value.trim();
                      }
                  }
              }
          }
          const uniqueTexts = [...new Set(collectedText)];
          const dateStr = uniqueTexts.join('\\n');
          const foundInSidePanel = uniqueTexts.length > 5;
          
          return {
              id: id,
              dateStr: dateStr,
              foundInSidePanel: foundInSidePanel,
              potentialFilename: potentialFilename
          };
      })();
    `;
    return await webview.executeJavaScript(script);
};
