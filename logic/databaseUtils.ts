
import { DatabaseEntry } from '../types';

/**
 * Generiert CSV und speichert sie im gleichen Verzeichnis wie die DB.
 */
export const exportDatabaseToCsv = async (files: Record<string, DatabaseEntry>, dbFilePath: string): Promise<string> => {
    const entries = Object.entries(files);
    if (entries.length === 0) throw new Error("Keine Daten zum Exportieren.");
    if (!window.electron) throw new Error("Kein Electron Kontext.");

    // Pfad berechnen: Gleicher Ordner, Dateiname mit Datum
    // dbFilePath sieht z.B. aus wie "C:/Users/X/GPhotos/gphotos_db.json"
    // Wir wollen "C:/Users/X/GPhotos/gphotos_export_YYYY-MM-DD.csv"
    
    // Windows/Unix Separator Detection (simpel)
    const isWin = dbFilePath.includes('\\');
    const sep = isWin ? '\\' : '/';
    
    const lastSlash = dbFilePath.lastIndexOf(sep);
    const basePath = lastSlash !== -1 ? dbFilePath.substring(0, lastSlash) : '.';
    
    const dateStr = new Date().toISOString().slice(0,10);
    const exportPath = `${basePath}${sep}gphotos_export_${dateStr}.csv`;

    // SORTIERUNG: Absteigend nach Timestamp (Jüngste zuerst)
    entries.sort((a, b) => b[1].timestamp - a[1].timestamp);

    const headers = [
        "ID", "Filename", "Original Name", "Web Date (Readable)", "Timestamp", "Original Date", 
        "Hash", "Source Hash", "Integrity Status", "Saved At", "Downloaded At", "Scanned At", "Missing Since", "Online Missing Since"
    ];

    const csvRows = ['\uFEFF' + headers.join(';')];
    for (const [id, file] of entries) {
        let statusStr = 'Nicht geprüft';
        if (file.integrityStatus === 'ok') statusStr = 'OK';
        else if (file.integrityStatus === 'corrupt') statusStr = 'Defekt';

        const row = [
            `"${id}"`, 
            `"${file.filename.replace(/"/g, '""')}"`, 
            `"${file.originalName ? file.originalName.replace(/"/g, '""') : ''}"`,
            `"${new Date(file.timestamp).toLocaleString()}"`,
            file.timestamp, 
            `"${file.originalDate || ''}"`, 
            `"${file.hash || ''}"`,
            `"${file.sourceHash || ''}"`,
            `"${statusStr}"`,
            file.savedAt ? new Date(file.savedAt).toLocaleString() : '',
            file.downloadedAt ? new Date(file.downloadedAt).toLocaleString() : '',
            file.scannedAt ? new Date(file.scannedAt).toLocaleString() : '',
            file.missingSince ? new Date(file.missingSince).toLocaleString() : '',
            file.onlineMissingSince ? new Date(file.onlineMissingSince).toLocaleString() : ''
        ];
        csvRows.push(row.join(';'));
    }

    const csvContent = csvRows.join('\n');
    const result = await window.electron.saveTextFile(exportPath, csvContent);
    
    if (result.success) {
        return result.path || exportPath;
    } else {
        throw new Error(result.error || "Fehler beim Speichern der CSV");
    }
};

/**
 * Löst Hash-Duplikate auf (F6 / Variante A).
 * Regeln:
 * - Einträge, die noch online vorhanden sind (kein missingSince/onlineMissingSince), werden NIE gelöscht.
 * - Sind Online-Einträge in der Gruppe: alle Offline-Kopien werden entfernt, Online-Einträge bleiben.
 * - Sind nur Offline-Einträge vorhanden: der beste bleibt (kürzester Name, dann ältestes Datum), Rest wird entfernt.
 * - Gruppen, in denen nichts gelöscht werden darf, werden gezählt und gemeldet.
 */
export const resolveDuplicatesOnDisk = async (
    duplicates: { hash: string; ids: string[] }[],
    files: Record<string, DatabaseEntry>,
    basePath: string
): Promise<{ deletedIds: string[], count: number, skippedOnlineGroups: number }> => {
    if (!window.electron) throw new Error("Electron Context missing");

    const deletedIds: string[] = [];
    let count = 0;
    let skippedOnlineGroups = 0;

    for (const group of duplicates) {
        const entries = group.ids
            .map(id => ({ id, entry: files[id] }))
            .filter((x): x is { id: string, entry: DatabaseEntry } => !!x.entry);

        const isOffline = (e: DatabaseEntry) => !!(e.missingSince || e.onlineMissingSince);
        const online = entries.filter(x => !isOffline(x.entry));

        let remove: { id: string, entry: DatabaseEntry }[] = [];
        if (online.length > 0) {
            // Online-Einträge unangetastet lassen; nur Offline-Kopien entfernen
            remove = entries.filter(x => isOffline(x.entry));
        } else {
            // Ausschließlich Offline-Einträge: besten behalten (kürzester Name, dann ältestes Datum)
            entries.sort((a, b) => {
                const lenDiff = a.entry.filename.length - b.entry.filename.length;
                if (lenDiff !== 0) return lenDiff;
                return a.entry.timestamp - b.entry.timestamp;
            });
            remove = entries.slice(1);
        }

        if (remove.length === 0) {
            skippedOnlineGroups++;
            continue;
        }

        for (const item of remove) {
            const success = await window.electron.deleteFile({
                basePath: basePath,
                filename: item.entry.filename,
                timestamp: item.entry.timestamp
            });
            if (success) {
                deletedIds.push(item.id);
                count++;
            }
        }
    }

    return { deletedIds, count, skippedOnlineGroups };
};
