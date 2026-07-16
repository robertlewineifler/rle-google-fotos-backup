
import { DatabaseEntry, IntegrityError } from '../types';

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
        "Hash", "Integrity Status", "Saved At", "Downloaded At", "Scanned At", "Missing Since"
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
            `"${statusStr}"`,
            file.savedAt ? new Date(file.savedAt).toLocaleString() : '',
            file.downloadedAt ? new Date(file.downloadedAt).toLocaleString() : '',
            file.scannedAt ? new Date(file.scannedAt).toLocaleString() : '',
            file.missingSince ? new Date(file.missingSince).toLocaleString() : ''
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
 * Löscht Orphans (vermisste Dateien) physisch und aus der DB.
 */
export const deleteOrphansFromDisk = async (
    orphans: {id: string, entry: DatabaseEntry}[], 
    basePath: string,
    onProgress: (msg: string) => void
): Promise<string[]> => {
    if (!window.electron) throw new Error("Electron Context missing");
    
    const deletedIds: string[] = [];
    
    for (const orphan of orphans) {
        await window.electron.deleteFile({
            basePath: basePath,
            filename: orphan.entry.filename,
            timestamp: orphan.entry.timestamp
        });
        deletedIds.push(orphan.id);
    }
    
    return deletedIds;
};

/**
 * Löst Duplikate auf (behält die erste Datei, löscht den Rest).
 */
export const resolveDuplicatesOnDisk = async (
    duplicates: { hash: string; ids: string[] }[],
    files: Record<string, DatabaseEntry>,
    basePath: string
): Promise<{ deletedIds: string[], count: number }> => {
    if (!window.electron) throw new Error("Electron Context missing");

    const deletedIds: string[] = [];
    let count = 0;

    for (const group of duplicates) {
        const entries = group.ids.map(id => ({ id, entry: files[id] }));
        // Sortieren: Kürzester Dateiname gewinnt, bei Gleichstand ältestes Datum
        entries.sort((a, b) => {
            const lenDiff = a.entry.filename.length - b.entry.filename.length;
            if (lenDiff !== 0) return lenDiff;
            return a.entry.timestamp - b.entry.timestamp;
        });

        // Alle außer dem Ersten löschen
        const remove = entries.slice(1);
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

    return { deletedIds, count };
};
