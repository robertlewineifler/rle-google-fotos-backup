




import piexif from 'piexifjs';

/**
 * Konvertiert ein Date-Objekt in das EXIF Format "YYYY:MM:DD HH:MM:SS"
 */
export const formatDateForExif = (date: Date): string => {
  const pad = (n: number) => (n < 10 ? '0' + n : n);
  
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  return `${year}:${month}:${day} ${hours}:${minutes}:${seconds}`;
};

/**
 * Erzeugt einen ISO-ähnlichen String "YYYY-MM-DD" basierend auf der LOKALEN Zeit des Date-Objekts.
 * Dies ist wichtig für die Gruppierung nach Tagen, da Google Photos visuelle Daten (Lokalzeit) nutzt.
 */
export const getIsoDateString = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

/**
 * Konvertiert einen EXIF-String "YYYY:MM:DD HH:MM:SS" zurück in ein Date Objekt.
 */
export const parseExifDateToDate = (exifStr: string): Date | null => {
    if(!exifStr || typeof exifStr !== 'string') return null;
    
    // Einfache Validierung und Split
    const parts = exifStr.split(' ');
    if(parts.length < 2) return null;
    
    const dateParts = parts[0].split(':');
    const timeParts = parts[1].split(':');
    
    if(dateParts.length < 3 || timeParts.length < 3) return null;
    
    const year = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10) - 1; // 0-based
    const day = parseInt(dateParts[2], 10);
    const hour = parseInt(timeParts[0], 10);
    const min = parseInt(timeParts[1], 10);
    const sec = parseInt(timeParts[2], 10);
    
    const d = new Date(year, month, day, hour, min, sec);
    return isNaN(d.getTime()) ? null : d;
};

/**
 * Versucht, das Datum aus dem Textblock der Google Photos Sidebar zu parsen.
 * IGNORIERT Zeitzonenangaben (GMT, UTC, +02:00), um strikt die visuelle Uhrzeit zu übernehmen.
 */
export const parseGoogleDateString = (textBlock: string): Date => {
    if (!textBlock) return new Date("Invalid");

    // BEREINIGUNG: Entferne Zeitzonen-Hinweise
    const cleanText = textBlock
        .replace(/\b(GMT|UTC|Z)[+-]?\d{0,4}/gi, '') 
        .replace(/[+-]\d{1,2}:\d{2}/g, '');

    // WICHTIG: Das aktuelle Datum wird genau JETZT ermittelt.
    const now = new Date();
    const currentYear = now.getFullYear();
    
    // Globale Suche nach Uhrzeit im gesamten Block
    let hours = 12;
    let minutes = 0;
    
    // Verbesserte Zeit-Suche: Suche bevorzugt nach Uhrzeiten, die "Uhr", "AM/PM" enthalten oder isoliert stehen
    const timeMatch = cleanText.match(/(?:^|\s|T|,)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?(Uhr|AM|PM|am|pm))?/);
    if (timeMatch) {
        hours = parseInt(timeMatch[1], 10);
        minutes = parseInt(timeMatch[2], 10);
        const suffix = timeMatch[4]?.toLowerCase();
        
        if (suffix === 'pm' && hours < 12) hours += 12;
        if (suffix === 'am' && hours === 12) hours = 0;
    }

    const months: {[key:string]: number} = {
        'jan': 0, 'jån': 0, 'jän': 0, 'january': 0, 'januar': 0,
        'feb': 1, 'feber': 1, 'february': 1, 'februar': 1,
        'mär': 2, 'mar': 2, 'march': 2, 'märz': 2, 'maerz': 2,
        'apr': 3, 'april': 3,
        'mai': 4, 'may': 4,
        'jun': 5, 'june': 5, 'juni': 5,
        'jul': 6, 'july': 6, 'juli': 6,
        'aug': 7, 'august': 7,
        'sep': 8, 'september': 8,
        'okt': 9, 'oct': 9, 'october': 9, 'oktober': 9,
        'nov': 10, 'november': 10,
        'dez': 11, 'dec': 11, 'december': 11, 'dezember': 11
    };

    const lines = cleanText.split(/[\r\n]+/);
    
    for (const line of lines) {
        const cleanLine = line.trim();
        if (cleanLine.length < 3) continue;

        // --- FILTER-LOGIK (Fix für falsche Album-Daten) ---
        // Ignoriere Zeilen, die nach Album-Metadaten aussehen
        // Beispiele: "1395 Elemente", "Geteilt", "4. Dez - 1. Jan"
        if (cleanLine.match(/(\d+)\s*(Elemente|Items|Photos|Fotos)/i)) continue;
        if (cleanLine.toLowerCase().includes('geteilt')) continue;
        if (cleanLine.toLowerCase().includes('shared')) continue;
        // Ignoriere Zeiträume (Datum - Datum), da wir ein punktuelles Aufnahmedatum wollen
        if (cleanLine.match(/\d+\.?\s*[a-zA-Z]{3,}\.?\s*[\-–]\s*\d+/)) continue; 

        // 1. Numerisch DD.MM.YYYY
        const numMatch = cleanLine.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (numMatch) {
            const day = parseInt(numMatch[1], 10);
            const month = parseInt(numMatch[2], 10) - 1;
            const year = parseInt(numMatch[3], 10);
            return new Date(year, month, day, hours, minutes, 0);
        }

        // 2. DD. Monat (Deutsch / Europäisch)
        const deMatch = cleanLine.match(/(\d{1,2})\.?\s*([a-zA-ZäöüÄÖÜß]{3,}\.?)/);
        if (deMatch) {
            const day = parseInt(deMatch[1], 10);
            const rawMonth = deMatch[2].replace('.', '');
            const monthStr = rawMonth.toLowerCase().substring(0, 3);
            const fullMonthStr = rawMonth.toLowerCase();

            let monthIndex = months[monthStr];
            if (monthIndex === undefined) monthIndex = months[fullMonthStr];

            if (monthIndex !== undefined) {
                let year = currentYear; // Standard: Aktuelles Systemjahr
                
                // Prüfen, ob eine Jahreszahl explizit im Text steht
                const yearMatch = cleanLine.match(/\b(19|20)\d{2}\b/);
                if (yearMatch) {
                    year = parseInt(yearMatch[0], 10);
                } 
                
                console.log(`Parsed Date: ${day}.${monthIndex + 1}.${year} (Raw: ${cleanLine})`);
                return new Date(year, monthIndex, day, hours, minutes, 0);
            }
        }

        // 3. Month DD (Englisch / US)
        const enMatch = cleanLine.match(/([a-zA-Z]{3,})\s+(\d{1,2})/);
        if (enMatch) {
            const monthStr = enMatch[1].toLowerCase().substring(0, 3);
            const fullMonthStr = enMatch[1].toLowerCase();
            const day = parseInt(enMatch[2], 10);

            let monthIndex = months[monthStr];
            if (monthIndex === undefined) monthIndex = months[fullMonthStr];

            if (monthIndex !== undefined) {
                let year = currentYear;
                const yearMatch = cleanLine.match(/\b(19|20)\d{2}\b/);
                if (yearMatch) {
                    year = parseInt(yearMatch[0], 10);
                } 
                
                return new Date(year, monthIndex, day, hours, minutes, 0);
            }
        }
    }

    // Fallback: Relative Daten
    const lowerText = cleanText.toLowerCase();
    if (lowerText.includes('heute') || lowerText.includes('today')) {
        const d = new Date();
        d.setHours(hours, minutes, 0, 0);
        return d;
    }
    if (lowerText.includes('gestern') || lowerText.includes('yesterday')) {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        d.setHours(hours, minutes, 0, 0);
        return d;
    }

    return new Date("Invalid"); 
};

export const blobToDataURL = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

export const dataURLtoBlob = async (dataurl: string): Promise<Blob> => {
    const res = await fetch(dataurl);
    return await res.blob();
}