
import React, { useState, useEffect, useMemo } from 'react';
import { DatabaseEntry, IntegrityResult, SkippedDownload, UntrackedFile, CleanupSummary, RenameCheckEntry } from '../types';

type CorrectionTab = 'missing' | 'corrupt' | 'skipped' | 'online' | 'untracked' | 'filenames' | 'duplicates';

interface CorrectionModalProps {
    orphans: { id: string, entry: DatabaseEntry }[];
    files: Record<string, DatabaseEntry>;
    skipped: SkippedDownload[]; // F10: Fotos mit Download-Start-Timeout
    onlineMissing: { id: string, entry: DatabaseEntry }[]; // F13: lokal vorhanden, online nicht gesehen
    basePath: string; // F22: für Struktur-/Inhaltsprüfung
    integrityResult: IntegrityResult | null; // F22: letzter Struktur-Check (Duplikate, Veraltet, Verwaiste)
    onClose: () => void;
    
    // Orphan Actions
    onDeleteOrphans: () => void; // Batch delete missing from DB
    onResetOrphans: () => void;
    onShowInFolder: (item: { id: string, entry: DatabaseEntry }) => void; // F16: im Windows Explorer anzeigen
    onOpenFile: (entry: DatabaseEntry) => void; // F16: im Standard-Viewer öffnen
    onNavigate: (id: string) => void; // Navigate to Web

    // Corrupt Actions
    onDeleteCorrupt: (id: string) => Promise<boolean>; // Single delete corrupt (disk only)
    onDeleteAllCorrupt: () => void | Promise<void>; // Batch delete corrupt (disk only)

    // F10: Skipped Actions
    onOpenSkipped: (id: string) => void; // Im Webview öffnen (Re-Download via "⬇ 1")
    onIgnoreSkipped: (id: string) => void; // Einzelnen Eintrag entfernen
    onIgnoreAllSkipped: () => void; // Alle Einträge entfernen

    // F13: OnlineMissing Actions
    onResetOnlineMissing: () => void; // Status zurücksetzen (Dateien behalten)
    onDeleteAllOnlineMissing: () => void; // Alle lokal + DB entfernen
    onDeleteOnlineMissing: (id: string) => void; // F27: Einzelnen Eintrag lokal + DB entfernen

    // F21: Untracked Actions
    onDeleteUntrackedFile?: (file: UntrackedFile) => Promise<boolean>;
    onShowUntrackedInExplorer?: (fullPath: string) => void;
    onOpenUntracked?: (fullPath: string) => void;
    onBeforeBulkDelete?: () => Promise<void>; // F28: DB-Backup vor Batch-Löschungen

    // F22: Prüfungen (aus dem früheren Strukturbericht)
    onCheckDone: (result: IntegrityResult) => void;
    onUpdateFileStatus?: (updates: Record<string, 'ok' | 'corrupt'>) => void;
    onExecuteDuplicates: () => void;
    onCleanLegacy?: () => void;
    // F29: Führt die bestätigte Dateinamen-Bereinigung aus (Umbenennungen/Duplikate/Endungen)
    onCleanFilenames?: () => Promise<CleanupSummary>;
}

// F26: Einheitlicher Leerzustand für alle Kategorie-Tabs
const TabEmpty: React.FC<{ text?: string }> = ({ text }) => (
    <div className="flex flex-col items-center justify-center h-32 text-slate-500 opacity-70 text-center">
        <div className="text-2xl mb-1">✓</div>
        <div>{text || 'Keine Einträge in dieser Kategorie.'}</div>
    </div>
);

export const CorrectionModal: React.FC<CorrectionModalProps> = ({ 
    orphans, files, skipped, onlineMissing, basePath, integrityResult, onClose, 
    onDeleteOrphans, onResetOrphans, onNavigate, onShowInFolder, onOpenFile,
    onDeleteCorrupt, onDeleteAllCorrupt,
    onOpenSkipped, onIgnoreSkipped, onIgnoreAllSkipped,
    onResetOnlineMissing, onDeleteAllOnlineMissing, onDeleteOnlineMissing,
    onDeleteUntrackedFile, onShowUntrackedInExplorer, onOpenUntracked, onBeforeBulkDelete,
    onCheckDone, onUpdateFileStatus, onExecuteDuplicates, onCleanLegacy, onCleanFilenames
}) => {
    const [refreshTrigger, setRefreshTrigger] = useState(0);

    // Live-Berechnung der defekten Dateien (refreshTrigger nötig, da `files` in-place mutiert wird)
    const corruptFiles = useMemo(() => {
        return (Object.entries(files) as [string, DatabaseEntry][])
            .filter(([_, e]) => e.integrityStatus === 'corrupt')
            .map(([id, entry]) => ({ id, entry }));
    }, [files, refreshTrigger]);

    // F21/F22: letzter Struktur-Check (Duplikate, Veraltet, Verwaiste) + lokale Verwaisten-Liste
    const [structureResult, setStructureResult] = useState<IntegrityResult | null>(integrityResult);
    const [untrackedFiles, setUntrackedFiles] = useState<UntrackedFile[]>(integrityResult?.untracked || []);
    useEffect(() => { setStructureResult(integrityResult); }, [integrityResult]);
    useEffect(() => { setUntrackedFiles(structureResult?.untracked || []); }, [structureResult]);

    // Prüf-Status
    const [structureRunning, setStructureRunning] = useState(false);
    const [contentRunning, setContentRunning] = useState(false);
    const [contentProgress, setContentProgress] = useState(0);
    const [contentTotal, setContentTotal] = useState(0);
    const [contentCurrent, setContentCurrent] = useState('');
    const [contentSummary, setContentSummary] = useState('');
    const [showContentDialog, setShowContentDialog] = useState(false); // F26: Auswahl vollständig/offen
    const [autoFixNotice, setAutoFixNotice] = useState(''); // F29: kurzer Banner nach bestätigter Bereinigung
    // F29: Bestätigungsdialog für die Dateinamen-Bereinigung (Detail-Liste wird erst auf Klick gerendert)
    const [showCleanupDialog, setShowCleanupDialog] = useState(false);
    const [showCleanupList, setShowCleanupList] = useState(false);
    const [cleanupRunning, setCleanupRunning] = useState(false);

    const corruptCount = corruptFiles.length;
    const untrackedCount = untrackedFiles.length;
    const duplicateCount = structureResult?.duplicates?.length || 0;
    const legacyCount = structureResult?.legacyCount || 0;

    // F26: Zählwerte für den Inhalt-prüfen-Dialog
    const contentSubsetCount = useMemo(
        () => (Object.values(files) as DatabaseEntry[]).filter(e => e.integrityStatus !== 'ok').length,
        [files, refreshTrigger]
    );
    const contentTotalCount = useMemo(() => Object.keys(files).length, [files, refreshTrigger]);

    const [activeTab, setActiveTab] = useState<CorrectionTab>(() => {
        if (orphans.length > 0) return 'missing';
        if ((Object.values(files) as DatabaseEntry[]).some(e => e.integrityStatus === 'corrupt')) return 'corrupt';
        if (skipped.length > 0) return 'skipped';
        if (onlineMissing.length > 0) return 'online';
        if ((integrityResult?.untracked?.length || 0) > 0) return 'untracked';
        return 'missing';
    });

    // F24: Dateinamen-Prüfung (Info-Tab, read-only) – Einzelzeilen nur für die relevanten Kategorien
    const renameInfo = structureResult?.renamable;
    const renameDisplayEntries = (renameInfo?.entries || []).filter(e =>
        e.status === 'protected' || e.status === 'noName' || e.status === 'nameMismatch' || e.status === 'collision'
    );

    const tabDefs: { id: CorrectionTab; label: string; count: number; activeClass: string; idleClass: string }[] = [
        { id: 'missing', label: 'Vermisst', count: orphans.length, activeClass: 'bg-amber-700 text-white border-amber-500', idleClass: 'text-amber-300 border-transparent hover:bg-slate-700' },
        { id: 'corrupt', label: 'Defekt', count: corruptCount, activeClass: 'bg-red-700 text-white border-red-500', idleClass: 'text-red-300 border-transparent hover:bg-slate-700' },
        { id: 'skipped', label: 'Übersprungen', count: skipped.length, activeClass: 'bg-sky-700 text-white border-sky-500', idleClass: 'text-sky-300 border-transparent hover:bg-slate-700' },
        { id: 'online', label: 'Online nicht gefunden', count: onlineMissing.length, activeClass: 'bg-violet-700 text-white border-violet-500', idleClass: 'text-violet-300 border-transparent hover:bg-slate-700' },
        { id: 'untracked', label: 'Verwaist', count: untrackedCount, activeClass: 'bg-orange-700 text-white border-orange-500', idleClass: 'text-orange-300 border-transparent hover:bg-slate-700' },
        { id: 'filenames', label: 'Dateinamen', count: renameDisplayEntries.length, activeClass: 'bg-teal-700 text-white border-teal-500', idleClass: 'text-teal-300 border-transparent hover:bg-slate-700' },
        { id: 'duplicates', label: 'Duplikate', count: duplicateCount, activeClass: 'bg-fuchsia-700 text-white border-fuchsia-500', idleClass: 'text-fuchsia-300 border-transparent hover:bg-slate-700' },
    ];
    // F29: Vorschau-Zähler für „Dateinamen bereinigen“
    const cleanupItems = structureResult?.cleanupPreview?.items || [];
    const cleanupRenameCount = cleanupItems.filter(i => i.kind === 'rename').length;
    const cleanupResolveCount = cleanupItems.filter(i => i.kind === 'resolve').length;
    const cleanupDeleteCount = cleanupItems.filter(i => i.kind === 'delete').length;
    const cleanupSuffixCount = cleanupItems.filter(i => i.reason === 'suffix').length;
    const cleanupSuffixRenameCount = cleanupItems.filter(i => i.kind === 'rename' && i.reason === 'suffix').length;
    const cleanupDoubleExtCount = cleanupItems.filter(i => i.reason === 'doubleExt').length;
    const cleanupExtLowerCount = cleanupItems.filter(i => i.reason === 'extLowercase').length;
    const cleanupTotal = cleanupItems.length;

    // F29: Dateinamen-Tab – Lazy-Klapplisten je Status (Filter/Sortierung erst beim Ausklappen)
    const [expandedFilenameStatus, setExpandedFilenameStatus] = useState<Record<string, boolean>>({});
    useEffect(() => { setExpandedFilenameStatus({}); }, [structureResult]);
    const anyFilenameExpanded = !!(expandedFilenameStatus.collision || expandedFilenameStatus.nameMismatch || expandedFilenameStatus.noName || expandedFilenameStatus.protected);
    const filenameEntriesByStatus = useMemo(() => {
        const map: Record<string, RenameCheckEntry[]> = {};
        const all = renameInfo?.entries || [];
        (['collision', 'nameMismatch', 'noName', 'protected'] as const).forEach(st => {
            if (!expandedFilenameStatus[st]) return;
            map[st] = all
                .filter(e => e.status === st)
                .sort((a, b) => a.currentName.localeCompare(b.currentName, 'de', { numeric: true, sensitivity: 'base' }));
        });
        return map;
    }, [expandedFilenameStatus, renameInfo]);

    // F29: Duplikate-Tab – Gruppen mit voraussichtlicher Aktion aufbereiten
    const duplicateGroups = useMemo(() => {
        const groups = structureResult?.duplicates || [];
        return groups.map(g => {
            const entries = g.ids.map(id => ({ id, entry: files[id] })).filter((x): x is { id: string; entry: DatabaseEntry } => !!x.entry);
            const isOffline = (e: DatabaseEntry) => !!(e.missingSince || e.onlineMissingSince);
            const online = entries.filter(x => !isOffline(x.entry));
            const keptIds = new Set<string>();
            if (online.length > 0) {
                online.forEach(x => keptIds.add(x.id));
            } else if (entries.length > 0) {
                const sorted = [...entries].sort((a, b) => {
                    const lenDiff = a.entry.filename.length - b.entry.filename.length;
                    if (lenDiff !== 0) return lenDiff;
                    return a.entry.timestamp - b.entry.timestamp;
                });
                keptIds.add(sorted[0].id);
            }
            const removableCount = entries.filter(x => !keptIds.has(x.id)).length;
            return { hash: g.hash, entries, keptIds, removableCount, skipped: online.length > 0 && removableCount === 0 };
        });
    }, [structureResult, files]);
    const duplicateRemovableTotal = duplicateGroups.reduce((s, g) => s + g.removableCount, 0);
    const duplicateResolvableGroups = duplicateGroups.filter(g => g.removableCount > 0).length;

    // F29: Führt die Bereinigung erst nach Bestätigung aus und zeigt danach den Erfolgs-Banner
    const handleCleanFilenames = async () => {
        if (!onCleanFilenames) return;
        setCleanupRunning(true);
        try {
            const s = await onCleanFilenames();
            const parts: string[] = [];
            if (s.renamed > 0) parts.push(`${s.renamed} umbenannt (${s.doubleExt} Doppelendungen, ${s.extLowercased} Endungen klein)`);
            if (s.removed > 0) parts.push(`${s.removed} Duplikate/Reste entfernt`);
            if (s.failed > 0) parts.push(`${s.failed} fehlgeschlagen (siehe Log)`);
            setAutoFixNotice(`✅ Bereinigt: ${parts.length > 0 ? parts.join(', ') : 'keine Änderungen nötig'}.`);
            setTimeout(() => setAutoFixNotice(''), 8000);
        } finally {
            setCleanupRunning(false);
            setShowCleanupDialog(false);
            setShowCleanupList(false);
        }
    };

    // F22: Struktur-Check (rein lesend; Dateiänderungen erst über „Dateinamen bereinigen“)
    const runStructureCheck = async () => {
        setStructureRunning(true);
        setAutoFixNotice('');
        try {
            const result = await window.electron.checkIntegrity(basePath, files, false);

            // Legacy-Zähler (Root-Feld + unbekannte Felder)
            let legacy = 0;
            if ((files as any)['scannedRanges']) legacy++;
            const validKeys = new Set([
                'filename', 'timestamp', 'originalDate', 'originalName',
                'savedAt', 'downloadedAt', 'scannedAt', 'hash', 'sourceHash', 'missingSince', 'id',
                'integrityStatus', 'integrityCheckedAt', 'size', 'onlineMissingSince'
            ]);
            for (const id in files) {
                const entry = files[id];
                for (const key in entry) {
                    if (!validKeys.has(key)) { legacy++; break; }
                }
            }
            result.legacyCount = legacy;

            setStructureResult(result);
            onCheckDone(result);
        } catch (e) {
            console.error(e);
            alert('Fehler bei Strukturprüfung');
        }
        setStructureRunning(false);
    };

    // F22: Inhalts-Check / Deep Scan (Chunks von 100)
    const runContentCheck = async (onlySubset: boolean) => {
        setContentRunning(true);
        setContentProgress(0);
        setContentCurrent('');
        setContentSummary('');

        let allEntries = (Object.entries(files) as [string, DatabaseEntry][]).map(([id, entry]) => ({ id, entry }));
        if (onlySubset) allEntries = allEntries.filter(i => i.entry.integrityStatus !== 'ok');
        setContentTotal(allEntries.length);

        if (allEntries.length === 0) {
            alert('Keine Dateien im gewählten Filter (alle sind OK).');
            setContentRunning(false);
            return;
        }

        const CHUNK_SIZE = 100;
        let processed = 0;
        let corruptFound = 0;
        const statusUpdates: Record<string, 'ok' | 'corrupt'> = {};

        for (let i = 0; i < allEntries.length; i += CHUNK_SIZE) {
            const chunk = allEntries.slice(i, i + CHUNK_SIZE);
            if (chunk.length > 0) setContentCurrent(chunk[0].entry.filename);
            const payload = chunk.map(c => ({ id: c.id, filename: c.entry.filename, timestamp: c.entry.timestamp }));
            try {
                const results = await window.electron.verifyFileIntegrityBatch(basePath, payload);
                Object.entries(results).forEach(([id, status]) => {
                    statusUpdates[id] = status;
                    if (files[id]) { files[id].integrityStatus = status; }
                    if (status === 'corrupt') corruptFound++;
                });
                setRefreshTrigger(prev => prev + 1);
            } catch (e) { console.error('Batch fail', e); }
            processed += chunk.length;
            setContentProgress(processed);
            await new Promise(r => setTimeout(r, 10));
        }

        if (onUpdateFileStatus) onUpdateFileStatus(statusUpdates);
        setRefreshTrigger(prev => prev + 1);
        setContentSummary(`Inhaltsprüfung: ${corruptFound} defekt von ${allEntries.length} geprüften Dateien.`);
        setContentRunning(false);
    };

    const handleDeleteCorrupt = async (id: string) => {
        const ok = await onDeleteCorrupt(id);
        if (ok) setRefreshTrigger(prev => prev + 1);
    };

    const handleDeleteAllCorrupt = async () => {
        await onDeleteAllCorrupt();
        setRefreshTrigger(prev => prev + 1);
    };

    // F21: verwaiste Dateien (Zeilen nach Löschen entfernen)
    const handleDeleteUntracked = async (file: UntrackedFile) => {
        if (!onDeleteUntrackedFile) return;
        const ok = await onDeleteUntrackedFile(file);
        if (ok) setUntrackedFiles(prev => prev.filter(f => f.path !== file.path));
    };

    const handleDeleteAllUntracked = async () => {
        if (!onDeleteUntrackedFile || untrackedFiles.length === 0) return;
        if (!confirm(`Wirklich alle ${untrackedFiles.length} verwaisten Dateien von der Festplatte löschen?`)) return;
        // F28: Force-Backup vor der Batch-Löschung
        if (onBeforeBulkDelete) await onBeforeBulkDelete();
        for (const f of [...untrackedFiles]) {
            const ok = await onDeleteUntrackedFile(f);
            if (ok) setUntrackedFiles(prev => prev.filter(x => x.path !== f.path));
        }
    };

    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[80] p-8">
            <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl max-w-5xl w-full flex flex-col max-h-[90vh] relative">
                
                {/* HEADER */}
                <div className="p-4 border-b border-slate-700 bg-slate-900 flex justify-between items-center gap-3 flex-wrap">
                    <div>
                        <h3 className="text-xl font-bold text-white flex items-center gap-2">🛠️ Prüfung & Korrekturen</h3>
                        <div className="text-xs text-slate-400 mt-0.5">
                            <span className="text-slate-200 font-bold">1.</span> Struktur prüfen →
                            <span className="text-slate-200 font-bold"> 2.</span> Befunde sichten →
                            <span className="text-slate-200 font-bold"> 3.</span> bereinigen (mit Bestätigung)
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => void runStructureCheck()}
                            disabled={structureRunning}
                            className={`bg-teal-600 hover:bg-teal-500 disabled:opacity-60 text-white px-4 py-2.5 rounded text-sm font-bold border border-teal-400 shadow-lg flex items-center gap-2 ${!structureResult && !structureRunning ? 'animate-pulse' : ''}`}
                            title="Zuerst prüfen: Struktur/Hashes/verwaiste Dateien werden geprüft (ändert keine Dateien)"
                        >
                            {structureRunning
                                ? <><span className="animate-spin rounded-full h-3.5 w-3.5 border-t-2 border-white inline-block"></span> Prüfe Struktur…</>
                                : <>🔍 Struktur prüfen</>}
                        </button>
                        <button
                            onClick={() => setShowContentDialog(true)}
                            disabled={contentRunning}
                            className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200 px-3 py-2.5 rounded text-xs border border-slate-500"
                            title="Optional: Dateien vollständig lesen und auf Defekte prüfen (empfohlen nach der Strukturprüfung)"
                        >
                            💾 Inhalt prüfen
                        </button>
                        <button onClick={onClose} className="text-slate-400 hover:text-white px-2 text-lg" title="Schließen">✕</button>
                    </div>
                </div>

                {/* STATUSZEILE (Prüfstatus / Veraltet) */}
                <div className="px-4 py-2 bg-slate-900/60 border-b border-slate-700 flex items-center justify-between gap-3 flex-wrap text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                        {structureRunning
                            ? <span className="flex items-center gap-2 text-slate-200"><span className="animate-spin rounded-full h-3 w-3 border-t-2 border-slate-200 inline-block"></span> Prüfe Struktur…</span>
                            : structureResult
                                ? <span className="text-slate-400">Struktur geprüft · Befunde in den Tabs · Veraltet <span className={legacyCount > 0 ? 'text-blue-400 font-bold' : 'text-slate-300'}>{legacyCount}</span></span>
                                : <span className="text-amber-300 font-bold">Noch nicht geprüft – starte zuerst „🔍 Struktur prüfen“ (oben rechts).</span>}
                        {contentSummary && <span className="ml-2 text-slate-300">{contentSummary}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                        {legacyCount > 0 && onCleanLegacy && (
                            <button onClick={onCleanLegacy} className="bg-blue-700 hover:bg-blue-600 text-white px-3 py-1 rounded text-[10px] font-bold">Veraltete Felder bereinigen</button>
                        )}
                    </div>
                </div>

                {/* F29: Banner nach bestätigter Bereinigung */}
                {autoFixNotice && (
                    <div className="px-4 py-2 bg-green-900/30 border-b border-green-800 text-xs text-green-200">
                        {autoFixNotice}
                    </div>
                )}

                {/* TABS */}
                <div className="flex gap-1 px-4 pt-3 bg-slate-800 border-b border-slate-700 overflow-x-auto">
                    {tabDefs.map(t => (
                        <button
                            key={t.id}
                            onClick={() => setActiveTab(t.id)}
                            className={`px-3 py-2 rounded-t text-xs font-bold border-b-2 whitespace-nowrap ${activeTab === t.id ? t.activeClass : t.idleClass}`}
                        >
                            {t.label} ({t.count})
                        </button>
                    ))}
                </div>
                
                    {/* TAB CONTENT */}
                <div className="overflow-y-auto flex-1 bg-slate-800 p-6 flex flex-col gap-8">
                    
                    {/* --- SECTION 1: MISSING FILES (ORPHANS) --- */}
                    {activeTab === 'missing' && (
                        <div className="flex flex-col gap-2">
                            <div className="flex justify-between items-center pb-2 border-b border-slate-700">
                                <h4 className="text-lg font-bold text-amber-400">⚠️ Vermisste Dateien ({orphans.length})</h4>
                                <div className="text-xs text-slate-400">In DB, aber nicht auf Festplatte</div>
                            </div>
                            
                            <div className="bg-amber-900/10 border border-amber-900/30 p-3 rounded text-xs text-slate-300">
                                Diese Dateien fehlen lokal. Du kannst sie aus der Datenbank löschen (Cleanup) oder im Webview öffnen, um sie neu herunterzuladen.
                            </div>

                            {orphans.length > 0 ? (<>
                            <div className="border border-slate-700 rounded bg-slate-900/30 max-h-[300px] overflow-y-auto">
                                <table className="w-full text-left text-xs text-slate-300">
                                    <thead className="bg-slate-800 text-slate-400 uppercase font-bold sticky top-0">
                                        <tr>
                                            <th className="p-2">Vermisst seit</th>
                                            <th className="p-2">Dateiname</th>
                                            <th className="p-2">Datum (DB)</th>
                                            <th className="p-2 text-right">Aktion</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {orphans.map((orphan, idx) => (
                                            <tr key={idx} className="border-b border-slate-700 hover:bg-slate-800/50">
                                                <td className="p-2 text-amber-500 whitespace-nowrap">
                                                    {orphan.entry.missingSince ? new Date(orphan.entry.missingSince).toLocaleDateString() : 'Unbekannt'}
                                                </td>
                                                <td className="p-2 font-mono text-white break-all">
                                                    {orphan.entry.filename}
                                                </td>
                                                <td className="p-2 text-slate-500">
                                                    {new Date(orphan.entry.timestamp).toLocaleDateString()}
                                                </td>
                                                <td className="p-2 text-right">
                                                    <button 
                                                        onClick={() => onNavigate(orphan.id)}
                                                        className="bg-blue-700 hover:bg-blue-600 text-white px-3 py-1 rounded text-[10px] font-bold"
                                                        title="Im Browser öffnen für Re-Download"
                                                    >
                                                        🌐 Web öffnen
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            
                            <div className="flex justify-end gap-3 mt-1">
                                <button 
                                    onClick={onResetOrphans}
                                    className="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded text-sm border border-slate-600"
                                >
                                    Status zurücksetzen (Ignorieren)
                                </button>
                                <button 
                                    onClick={onDeleteOrphans}
                                    className="bg-amber-700 hover:bg-amber-600 text-white px-4 py-2 rounded text-sm font-bold shadow"
                                >
                                    Alle {orphans.length} aus DB entfernen
                                </button>
                            </div>
                            </>) : (<TabEmpty />)}
                        </div>
                    )}

                    {/* --- SECTION 2: CORRUPT FILES --- */}
                    {activeTab === 'corrupt' && (
                        <div className="flex flex-col gap-2">
                            <div className="flex justify-between items-center pb-2 border-b border-slate-700">
                                <h4 className="text-lg font-bold text-red-400">❌ Defekte Dateien ({corruptFiles.length})</h4>
                                <div className="text-xs text-slate-400">0 Bytes oder Lesefehler</div>
                            </div>

                            <div className="bg-red-900/10 border border-red-900/30 p-3 rounded text-xs text-slate-300">
                                Diese Dateien sind kaputt. Lösche sie von der Festplatte, damit sie beim nächsten Durchlauf automatisch neu geladen werden.
                            </div>

                            {corruptFiles.length > 0 ? (<>
                            <div className="border border-slate-700 rounded bg-slate-900/30 max-h-[300px] overflow-y-auto">
                                <table className="w-full text-left text-xs text-slate-300">
                                    <thead className="bg-slate-800 text-slate-400 uppercase font-bold sticky top-0">
                                        <tr>
                                            <th className="p-2">Dateiname</th>
                                            <th className="p-2">Datum</th>
                                            <th className="p-2 text-right">Aktion</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {corruptFiles.map((item, idx) => (
                                            <tr key={idx} className="border-b border-slate-700 hover:bg-slate-800/50">
                                                <td className="p-2 font-mono text-red-300 font-bold">{item.entry.filename}</td>
                                                <td className="p-2">{new Date(item.entry.timestamp).toLocaleDateString()}</td>
                                                <td className="p-2 text-right flex justify-end gap-2">
                                                    <button 
                                                        onClick={() => onShowInFolder(item)}
                                                        className="bg-slate-600 hover:bg-slate-500 text-white px-2 py-1 rounded text-[10px]"
                                                        title="Im Windows Explorer anzeigen"
                                                    >
                                                        📂 Explorer
                                                    </button>
                                                    <button 
                                                        onClick={() => onOpenFile(item.entry)}
                                                        className="bg-emerald-700 hover:bg-emerald-600 text-white px-2 py-1 rounded text-[10px]"
                                                        title="Im Standard-Viewer öffnen"
                                                    >
                                                        🖼️ Anzeigen
                                                    </button>
                                                    <button 
                                                        onClick={() => onNavigate(item.id)}
                                                        className="bg-blue-700 hover:bg-blue-600 text-white px-2 py-1 rounded text-[10px]"
                                                        title="Im Browser öffnen"
                                                    >
                                                        🌐 Web
                                                    </button>
                                                    <button 
                                                        onClick={() => handleDeleteCorrupt(item.id)} 
                                                        className="bg-red-700 hover:bg-red-600 text-white px-2 py-1 rounded text-[10px]"
                                                        title="Datei von Festplatte löschen, DB behalten"
                                                    >
                                                        🗑 Löschen
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            <div className="flex justify-end gap-3 mt-1">
                                <button 
                                    onClick={handleDeleteAllCorrupt}
                                    className="bg-red-800 hover:bg-red-700 text-white px-4 py-2 rounded text-sm font-bold shadow border border-red-600"
                                >
                                    Alle {corruptFiles.length} von Festplatte löschen (Re-Download Planen)
                                </button>
                            </div>
                            </>) : (<TabEmpty />)}
                        </div>
                    )}

                    {/* --- SECTION 3: SKIPPED DOWNLOADS (F10) --- */}
                    {activeTab === 'skipped' && (
                        <div className="flex flex-col gap-2">
                            <div className="flex justify-between items-center pb-2 border-b border-slate-700">
                                <h4 className="text-lg font-bold text-sky-400">⏭️ Übersprungen – Downloadstart fehlgeschlagen ({skipped.length})</h4>
                                <div className="text-xs text-slate-400">Kein Start-Signal innerhalb von 45 s</div>
                            </div>
                            <div className="bg-sky-900/10 border border-sky-900/30 p-3 rounded text-xs text-slate-300">
                                Bei diesen Fotos kam nach Shift+D kein Download-Startsignal. Öffne sie im Webview und nutze dort „⬇ 1“ (Einzeldownload ohne Zeitlimit), oder sie werden beim nächsten Backup-Lauf automatisch nachgeladen.
                            </div>
                            {skipped.length > 0 ? (<>
                            <div className="border border-slate-700 rounded bg-slate-900/30 max-h-[300px] overflow-y-auto">
                                <table className="w-full text-left text-xs text-slate-300">
                                    <thead className="bg-slate-800 text-slate-400 uppercase font-bold sticky top-0">
                                        <tr>
                                            <th className="p-2">Erkannt am</th>
                                            <th className="p-2">Datum (Web)</th>
                                            <th className="p-2">Dateiname</th>
                                            <th className="p-2">ID</th>
                                            <th className="p-2 text-right">Aktion</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {skipped.map((item, idx) => (
                                            <tr key={idx} className="border-b border-slate-700 hover:bg-slate-800/50">
                                                <td className="p-2 text-sky-400 whitespace-nowrap">
                                                    {new Date(item.detectedAt).toLocaleString()}
                                                    {item.mode === 'album' && <span className="ml-1 text-[9px] bg-purple-900 text-purple-200 px-1 rounded">Album</span>}
                                                </td>
                                                <td className="p-2 text-slate-400 whitespace-nowrap">{item.webTimestamp ? new Date(item.webTimestamp).toLocaleDateString() : '—'}</td>
                                                <td className="p-2 font-mono text-white break-all">{item.filename || '—'}</td>
                                                <td className="p-2 font-mono text-slate-500 break-all max-w-[180px]" title={item.id}>{item.id}</td>
                                                <td className="p-2 text-right whitespace-nowrap">
                                                    <button 
                                                        onClick={() => onOpenSkipped(item.id)}
                                                        className="bg-blue-700 hover:bg-blue-600 text-white px-2 py-1 rounded text-[10px] mr-1 font-bold"
                                                        title="Im Webview öffnen für Einzeldownload"
                                                    >
                                                        🌐 Web öffnen
                                                    </button>
                                                    <button 
                                                        onClick={() => onIgnoreSkipped(item.id)}
                                                        className="bg-slate-600 hover:bg-slate-500 text-white px-2 py-1 rounded text-[10px]"
                                                        title="Eintrag aus der Liste entfernen"
                                                    >
                                                        ✖ Ignorieren
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <div className="flex justify-end gap-3 mt-1">
                                <button 
                                    onClick={onIgnoreAllSkipped}
                                    className="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded text-sm border border-slate-600"
                                >
                                    Alle {skipped.length} ignorieren
                                </button>
                            </div>
                            </>) : (<TabEmpty />)}
                        </div>
                    )}

                    {/* --- SECTION 4: ONLINE MISSING (F13) --- */}
                    {activeTab === 'online' && (
                        <div className="flex flex-col gap-2">
                            <div className="flex justify-between items-center pb-2 border-b border-slate-700">
                                <h4 className="text-lg font-bold text-violet-400">🌐 Online nicht gefunden ({onlineMissing.length})</h4>
                                <div className="text-xs text-slate-400">Datei lokal vorhanden, im Scan nicht gesehen</div>
                            </div>
                            <div className="bg-violet-900/10 border border-violet-900/30 p-3 rounded text-xs text-slate-300">
                                Diese Dateien liegen lokal vor, wurden im vollständigen Scan-Tag aber nicht online gefunden (evtl. auf Google gelöscht oder eine Scan-Lücke). Prüfe sie lokal im Explorer oder Standard-Viewer (funktioniert auch, wenn das Foto online nicht mehr existiert), öffne sie im Webview, behalte sie (Status zurücksetzen) oder lösche sie lokal inklusive DB-Eintrag.
                            </div>
                            {onlineMissing.length > 0 ? (<>
                            <div className="border border-slate-700 rounded bg-slate-900/30 max-h-[300px] overflow-y-auto">
                                <table className="w-full text-left text-xs text-slate-300">
                                    <thead className="bg-slate-800 text-slate-400 uppercase font-bold sticky top-0">
                                        <tr>
                                            <th className="p-2">Erkannt am</th>
                                            <th className="p-2">Dateiname</th>
                                            <th className="p-2">Datum (DB)</th>
                                            <th className="p-2 text-right">Aktion</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {onlineMissing.map((item, idx) => (
                                            <tr key={idx} className="border-b border-slate-700 hover:bg-slate-800/50">
                                                <td className="p-2 text-violet-400 whitespace-nowrap">
                                                    {item.entry.onlineMissingSince ? new Date(item.entry.onlineMissingSince).toLocaleString() : 'Unbekannt'}
                                                </td>
                                                <td className="p-2 font-mono text-white break-all">{item.entry.filename}</td>
                                                <td className="p-2 text-slate-500">{new Date(item.entry.timestamp).toLocaleDateString()}</td>
                                                <td className="p-2 text-right whitespace-nowrap">
                                                    <button 
                                                        onClick={() => onShowInFolder(item)}
                                                        className="bg-slate-600 hover:bg-slate-500 text-white px-2 py-1 rounded text-[10px] mr-1"
                                                        title="Im Windows Explorer anzeigen"
                                                    >
                                                        📂 Explorer
                                                    </button>
                                                    <button 
                                                        onClick={() => onOpenFile(item.entry)}
                                                        className="bg-emerald-700 hover:bg-emerald-600 text-white px-2 py-1 rounded text-[10px] mr-1"
                                                        title="Im Standard-Viewer öffnen (auch offline verfügbar)"
                                                    >
                                                        🖼️ Anzeigen
                                                    </button>
                                                    <button 
                                                        onClick={() => onNavigate(item.id)}
                                                        className="bg-slate-600 hover:bg-slate-500 text-slate-400 px-3 py-1 rounded text-[10px] font-bold"
                                                        title="Foto ist online vermutlich nicht mehr vorhanden – Versuch trotzdem möglich"
                                                    >
                                                        🌐 Web öffnen
                                                    </button>
                                                    <button 
                                                        onClick={() => onDeleteOnlineMissing(item.id)}
                                                        className="bg-red-700 hover:bg-red-600 text-white px-2 py-1 rounded text-[10px] ml-1"
                                                        title="Datei lokal und DB-Eintrag löschen"
                                                    >
                                                        🗑 Löschen
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <div className="flex justify-end gap-3 mt-1">
                                <button 
                                    onClick={onResetOnlineMissing}
                                    className="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded text-sm border border-slate-600"
                                >
                                    Status zurücksetzen (Behalten)
                                </button>
                                <button 
                                    onClick={onDeleteAllOnlineMissing}
                                    className="bg-red-800 hover:bg-red-700 text-white px-4 py-2 rounded text-sm font-bold shadow border border-red-600"
                                >
                                    Alle {onlineMissing.length} lokal löschen
                                </button>
                            </div>
                            </>) : (<TabEmpty />)}
                        </div>
                    )}

                    {/* --- SECTION 5: VERWAISTE DATEIEN (F21/F22) --- */}
                    {activeTab === 'untracked' && (
                        <div className="flex flex-col gap-2">
                            <div className="flex justify-between items-center pb-2 border-b border-slate-700">
                                <h4 className="text-lg font-bold text-orange-400">Verwaiste Dateien ({untrackedCount})</h4>
                                <div className="text-xs text-slate-400">Auf der Platte, aber in keinem DB-Eintrag</div>
                            </div>
                            <div className="bg-orange-900/10 border border-orange-900/30 p-3 rounded text-xs text-slate-300">
                                Diese Dateien liegen in den Jahres-/Monatsordnern, sind aber keinem DB-Eintrag zugeordnet. Hash-identische Duplikate werden beim Struktur-Check vorgemerkt und über „✨ Dateinamen bereinigen“ entfernt; eindeutige Dateien können hier geprüft oder gelöscht werden.
                            </div>
                            {untrackedCount > 0 ? (<>
                            <div className="border border-slate-700 rounded bg-slate-900/30 max-h-[300px] overflow-y-auto">
                                <table className="w-full text-left text-xs text-slate-300">
                                    <thead className="bg-slate-800 text-slate-400 uppercase font-bold sticky top-0">
                                        <tr>
                                            <th className="p-2">Dateiname</th>
                                            <th className="p-2">Ordner</th>
                                            <th className="p-2">Größe</th>
                                            <th className="p-2">Hinweis</th>
                                            <th className="p-2 text-right">Aktion</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {untrackedFiles.map((f, i) => (
                                            <tr key={i} className="border-b border-slate-700 hover:bg-slate-800/50">
                                                <td className="p-2 font-mono text-orange-200 break-all">{f.filename}</td>
                                                <td className="p-2 text-slate-400 whitespace-nowrap">{f.year}/{f.month}</td>
                                                <td className="p-2 text-slate-400 whitespace-nowrap">{(f.size / 1024 / 1024).toFixed(1)} MB</td>
                                                <td className="p-2 whitespace-nowrap">
                                                    {f.trackedDuplicate
                                                        ? <span className="text-amber-300">Basisdatei – DB verweist auf Duplikat {f.trackedDuplicate.filename}</span>
                                                        : f.duplicateOf
                                                            ? <span className="text-amber-300">Duplikat von {f.duplicateOf}</span>
                                                            : <span className="text-slate-500">nicht in DB</span>}
                                                </td>
                                                <td className="p-2 text-right whitespace-nowrap">
                                                    <button onClick={() => onShowUntrackedInExplorer?.(f.path)} className="bg-slate-600 hover:bg-slate-500 text-white px-2 py-1 rounded text-[10px] mr-1" title="Im Windows Explorer anzeigen">📂 Explorer</button>
                                                    <button onClick={() => onOpenUntracked?.(f.path)} className="bg-emerald-700 hover:bg-emerald-600 text-white px-2 py-1 rounded text-[10px] mr-1" title="Im Standard-Viewer öffnen">🖼️ Anzeigen</button>
                                                    {!f.trackedDuplicate && (
                                                        <button onClick={() => handleDeleteUntracked(f)} className="bg-red-700 hover:bg-red-600 text-white px-2 py-1 rounded text-[10px]" title="Datei von der Festplatte löschen">🗑 Löschen</button>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <div className="flex justify-end mt-1">
                                <button onClick={handleDeleteAllUntracked} className="bg-orange-800 hover:bg-orange-700 text-white px-4 py-2 rounded text-sm font-bold shadow border border-orange-600">Alle {untrackedCount} löschen</button>
                            </div>
                            </>) : (<TabEmpty text={structureResult ? 'Keine verwaisten Dateien gefunden.' : 'Noch nicht geprüft – bitte „🔍 Struktur prüfen“ starten.'} />)}
                        </div>
                    )}

                    {/* --- SECTION 7: DUPLIKATE (F29: DB-Einträge mit identischem Inhalt) --- */}
                    {activeTab === 'duplicates' && (
                        <div className="flex flex-col gap-2">
                            <div className="flex justify-between items-center pb-2 border-b border-slate-700">
                                <h4 className="text-lg font-bold text-fuchsia-400">🔁 Duplikate ({duplicateCount})</h4>
                                <div className="text-xs text-slate-400">DB-Einträge mit identischem Dateiinhalt (SHA-256)</div>
                            </div>
                            <div className="bg-fuchsia-900/10 border border-fuchsia-900/30 p-3 rounded text-xs text-slate-300">
                                Mehrere Google-Fotos in der Datenbank haben denselben Dateiinhalt. Beim Bereinigen werden <strong>Online-Einträge nie gelöscht</strong>: Sind Online-Einträge dabei, verschwinden nur Offline-Kopien; sind alle offline, bleibt der kürzeste Name (bei Gleichstand der älteste). Dateien <strong>ohne DB-Eintrag</strong> („Duplikat von …“) stehen dagegen im Tab <strong>Verwaist</strong>.
                            </div>
                            {duplicateGroups.length === 0 ? (
                                <TabEmpty text={structureResult ? 'Keine Duplikate gefunden.' : 'Noch nicht geprüft – bitte „🔍 Struktur prüfen“ starten.'} />
                            ) : (
                                <>
                                <div className="flex flex-col gap-3">
                                    {duplicateGroups.map((g, gi) => (
                                        <div key={gi} className="border border-slate-700 rounded bg-slate-900/30">
                                            <div className="px-3 py-2 bg-slate-900/60 border-b border-slate-700 text-[10px] font-mono text-slate-400 flex justify-between gap-2 flex-wrap">
                                                <span>Gruppe {gi + 1} · {g.entries.length} Einträge · Hash {g.hash.slice(0, 12)}…</span>
                                                {g.removableCount === 0
                                                    ? <span className="text-amber-300 font-bold">wird übersprungen – alle Einträge online</span>
                                                    : <span className="text-red-300 font-bold">{g.removableCount} Datei(en) werden gelöscht</span>}
                                            </div>
                                            <table className="w-full text-left text-xs text-slate-300">
                                                <thead className="bg-slate-800 text-slate-400 uppercase font-bold">
                                                    <tr>
                                                        <th className="p-2">Dateiname</th>
                                                        <th className="p-2">Ordner</th>
                                                        <th className="p-2">Status</th>
                                                        <th className="p-2">Voraussichtliche Aktion</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {g.entries.map(e => {
                                                        const d = new Date(e.entry.timestamp);
                                                        const kept = g.keptIds.has(e.id);
                                                        return (
                                                            <tr key={e.id} className="border-b border-slate-700 hover:bg-slate-800/50">
                                                                <td className="p-2 font-mono text-white break-all">{e.entry.filename}</td>
                                                                <td className="p-2 text-slate-400 whitespace-nowrap">{d.getFullYear()}/{(d.getMonth() + 1).toString().padStart(2, '0')}</td>
                                                                <td className="p-2 whitespace-nowrap">
                                                                    {e.entry.missingSince
                                                                        ? <span className="text-amber-300">Vermisst</span>
                                                                        : e.entry.onlineMissingSince
                                                                            ? <span className="text-violet-300">Online nicht gefunden</span>
                                                                            : <span className="text-green-300">Online</span>}
                                                                </td>
                                                                <td className="p-2 whitespace-nowrap">
                                                                    {kept
                                                                        ? <span className="text-green-300">behalten</span>
                                                                        : <span className="text-red-300">wird gelöscht</span>}
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    ))}
                                </div>
                                <div className="flex justify-end items-center gap-3 mt-1">
                                    <button
                                        onClick={onExecuteDuplicates}
                                        disabled={duplicateRemovableTotal === 0}
                                        className="bg-fuchsia-800 hover:bg-fuchsia-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded text-sm font-bold shadow border border-fuchsia-600"
                                        title={duplicateRemovableTotal === 0 ? 'Alle Gruppen sind komplett online – es gibt nichts zu löschen.' : 'Entfernt nur Offline-Kopien (Online-Einträge bleiben immer erhalten); zuvor wird ein DB-Backup erstellt.'}
                                    >
                                        🗑 Duplikate bereinigen ({duplicateRemovableTotal} Dateien in {duplicateResolvableGroups} Gruppen)
                                    </button>
                                </div>
                                </>
                            )}
                        </div>
                    )}

                    {/* --- SECTION 6: DATEINAMEN (F24/F29: prominente Stats + Lazy-Klapplisten) --- */}
                    {activeTab === 'filenames' && (
                        <div className="flex flex-col gap-3">
                            <div className="flex justify-between items-center pb-2 border-b border-slate-700">
                                <h4 className="text-lg font-bold text-teal-400">Dateinamen-Prüfung</h4>
                                <div className="text-xs text-slate-400">Nur Information – Ausführung über „✨ Dateinamen bereinigen“</div>
                            </div>
                            <div className="bg-teal-900/10 border border-teal-900/30 p-3 rounded text-xs text-slate-300">
                                Geprüft werden Dateien mit Zähler im Namen („Name (n).ext“) sowie doppelte und großgeschriebene Endungen (z. B. „IMG_3181.JPG.jpg“, „IMG_2851.JPG“). Umbenennungen und hash-identische Duplikate werden vorgemerkt und erst nach Bestätigung ausgeführt; Kollisionen (zwei verschiedene Fotos mit gleichem Namen) bleiben unangetastet.
                            </div>

                            {!renameInfo ? (
                                <TabEmpty text={structureRunning ? 'Prüfe Dateinamen…' : 'Noch nicht geprüft – bitte „🔍 Struktur prüfen“ starten.'} />
                            ) : (
                                <>
                                    {/* F29: prominente Statistik */}
                                    <div className="bg-slate-900/60 border border-teal-800/50 rounded-lg p-4 flex flex-col gap-3">
                                        <div className="flex items-end justify-between gap-4 flex-wrap">
                                            <div className="flex items-end gap-4 flex-wrap">
                                                <div>
                                                    <div className="text-[10px] uppercase tracking-widest text-teal-400 font-bold">Vorgemerkt für Bereinigung</div>
                                                    <div className="text-3xl font-extrabold text-teal-300 leading-none mt-1">{cleanupTotal}</div>
                                                </div>
                                                <div className="flex gap-2 flex-wrap text-[11px] pb-0.5">
                                                    <span className="bg-teal-900/40 border border-teal-700/50 text-teal-200 px-2 py-0.5 rounded-full">{cleanupSuffixCount} × „(n)“</span>
                                                    <span className="bg-teal-900/40 border border-teal-700/50 text-teal-200 px-2 py-0.5 rounded-full">{cleanupDoubleExtCount} × Doppelendung</span>
                                                    <span className="bg-teal-900/40 border border-teal-700/50 text-teal-200 px-2 py-0.5 rounded-full">{cleanupExtLowerCount} × Endung klein</span>
                                                    <span className="bg-teal-900/40 border border-teal-700/50 text-teal-200 px-2 py-0.5 rounded-full">{cleanupResolveCount + cleanupDeleteCount} × Duplikate/Reste</span>
                                                </div>
                                            </div>
                                            {cleanupTotal > 0 && onCleanFilenames ? (
                                                <button
                                                    onClick={() => { setShowCleanupDialog(true); setShowCleanupList(false); }}
                                                    className="bg-teal-600 hover:bg-teal-500 text-white px-4 py-2 rounded text-sm font-bold shadow border border-teal-400"
                                                    title="Vorgemerkte Umbenennungen/Löschungen nach Bestätigung ausführen"
                                                >
                                                    ✨ Dateinamen bereinigen ({cleanupTotal})
                                                </button>
                                            ) : (
                                                <span className="text-[11px] text-slate-500 pb-1">Nichts zu bereinigen.</span>
                                            )}
                                        </div>
                                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
                                            <div className="bg-slate-800/80 border border-slate-700 rounded p-2 text-center">
                                                <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Namen mit „(n)“</div>
                                                <div className="text-xl font-bold text-slate-200">{renameInfo.stats?.nTotal || 0}</div>
                                            </div>
                                            {([
                                                { key: 'protected', label: 'Geschützt', value: renameInfo.stats?.legitNames || 0, color: 'text-slate-200', hint: 'Echter Google-Name – wird nicht umbenannt (Endung ggf. klein).' },
                                                { key: 'collision', label: 'Kollisionen', value: renameInfo.stats?.collisionPair || 0, color: (renameInfo.stats?.collisionPair || 0) > 0 ? 'text-red-300' : 'text-slate-400', hint: 'Zielname ist durch ein anderes Foto belegt – bleibt unangetastet.' },
                                                { key: 'nameMismatch', label: 'Namensabweichung', value: renameInfo.stats?.nameMismatch || 0, color: (renameInfo.stats?.nameMismatch || 0) > 0 ? 'text-amber-300' : 'text-slate-400', hint: 'Gespeicherter Originalname passt nicht (z. B. Altbestand).' },
                                                { key: 'noName', label: 'Ohne Originalname', value: renameInfo.stats?.noName || 0, color: (renameInfo.stats?.noName || 0) > 0 ? 'text-amber-300' : 'text-slate-400', hint: 'Kein Originalname in der DB gespeichert.' },
                                            ] as const).map(t => (
                                                <button
                                                    key={t.key}
                                                    onClick={() => setExpandedFilenameStatus(prev => ({ ...prev, [t.key]: !prev[t.key] }))}
                                                    className={`border rounded p-2 text-center transition ${expandedFilenameStatus[t.key] ? 'bg-teal-900/40 border-teal-500' : 'bg-slate-800/80 border-slate-700 hover:border-teal-600'}`}
                                                    title={`${t.hint} Klicken zum ${expandedFilenameStatus[t.key] ? 'Ausblenden' : 'Anzeigen'}.`}
                                                >
                                                    <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">{t.label} <span className="text-slate-500">{expandedFilenameStatus[t.key] ? '▲' : '▼'}</span></div>
                                                    <div className={`text-xl font-bold ${t.color}`}>{t.value}</div>
                                                </button>
                                            ))}
                                            <div className="bg-slate-800/80 border border-slate-700 rounded p-2 text-center">
                                                <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Datei fehlt</div>
                                                <div className={`text-xl font-bold ${(renameInfo.stats?.currentMissing || 0) > 0 ? 'text-red-300' : 'text-slate-400'}`}>{renameInfo.stats?.currentMissing || 0}</div>
                                            </div>
                                        </div>
                                        {anyFilenameExpanded && (
                                            <button onClick={() => setExpandedFilenameStatus({})} className="self-start text-[10px] text-slate-400 hover:text-white underline">Alle Listen ausblenden</button>
                                        )}
                                    </div>

                                    {/* F29: Lazy-Listen je Status (Filter/Sortierung erst beim Ausklappen) */}
                                    {([
                                        { key: 'collision', label: 'Kollisionen', hint: (e: RenameCheckEntry) => `Zielname „${e.newName}“ ist belegt (anderes Foto)` },
                                        { key: 'nameMismatch', label: 'Namensabweichung', hint: () => 'Originalname passt nicht zum Basisnamen' },
                                        { key: 'noName', label: 'Ohne Originalname', hint: () => 'Kein Originalname gespeichert' },
                                        { key: 'protected', label: 'Geschützt', hint: () => 'Echter Google-Name – geschützt' },
                                    ] as const).map(g => {
                                        if (!expandedFilenameStatus[g.key]) return null;
                                        const rows = filenameEntriesByStatus[g.key] || [];
                                        return (
                                            <div key={g.key} className="flex flex-col gap-1">
                                                <div className="text-xs font-bold text-teal-300">{g.label} ({rows.length})</div>
                                                <div className="border border-slate-700 rounded bg-slate-900/30 max-h-[400px] overflow-y-auto">
                                                    <table className="w-full text-left text-xs text-slate-300">
                                                        <thead className="bg-slate-800 text-slate-400 uppercase font-bold sticky top-0">
                                                            <tr>
                                                                <th className="p-2">Dateiname</th>
                                                                <th className="p-2">Originalname</th>
                                                                <th className="p-2">Hinweis</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {rows.map((e, i) => (
                                                                <tr key={i} className="border-b border-slate-700 hover:bg-slate-800/50">
                                                                    <td className="p-2 font-mono text-white break-all">{e.currentName}</td>
                                                                    <td className="p-2 font-mono text-slate-400 break-all">{e.originalName || '—'}</td>
                                                                    <td className="p-2 whitespace-nowrap">{g.hint(e)}</td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </>
                            )}
                        </div>
                    )}

                </div>

                {/* FOOTER */}
                <div className="p-4 border-t border-slate-700 flex justify-end bg-slate-900 rounded-b-lg">
                    <button 
                        onClick={onClose}
                        className="bg-slate-700 hover:bg-slate-600 text-white px-6 py-2 rounded text-sm"
                    >
                        Schließen
                    </button>
                </div>

                {/* F29: Bestätigungsdialog für die Dateinamen-Bereinigung (Liste lazy) */}
                {showCleanupDialog && (
                    <div className="absolute inset-0 bg-black/80 z-20 flex items-center justify-center rounded-lg p-6">
                        <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col">
                            <div className="p-4 border-b border-slate-700 bg-slate-900">
                                <h4 className="text-lg font-bold text-white">✨ Dateinamen bereinigen</h4>
                                <div className="text-xs text-slate-400 mt-0.5">Vor der Ausführung wird automatisch ein DB-Backup erstellt.</div>
                            </div>
                            <div className="p-4 overflow-y-auto flex flex-col gap-3 text-sm text-slate-200">
                                <ul className="list-disc list-inside flex flex-col gap-1">
                                    <li><strong>{cleanupRenameCount}</strong> Datei(en) umbenennen ({cleanupSuffixRenameCount} × „(n)“, {cleanupDoubleExtCount} × Doppelendung, {cleanupExtLowerCount} × Endung kleinschreiben)</li>
                                    <li><strong>{cleanupResolveCount + cleanupDeleteCount}</strong> Duplikat(e)/Kollisionsrest(e) entfernen ({cleanupResolveCount} getrackte „(n)“-Auflösungen, {cleanupDeleteCount} verwaiste Duplikate)</li>
                                </ul>
                                <div className="text-xs text-slate-400">
                                    Echte Kollisionen (anderer Inhalt), fehlende Dateien und Hash-Abweichungen werden nicht angetastet und beim nächsten Check erneut angeboten.
                                </div>
                                <button
                                    onClick={() => setShowCleanupList(v => !v)}
                                    className="self-start bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-1 rounded text-xs"
                                >
                                    {showCleanupList ? '📋 Liste ausblenden' : `📋 Liste anzeigen (${cleanupTotal})`}
                                </button>
                                {showCleanupList && (
                                    <div className="border border-slate-700 rounded bg-slate-900/40 max-h-[300px] overflow-y-auto">
                                        <table className="w-full text-left text-[11px] text-slate-300">
                                            <thead className="bg-slate-800 text-slate-400 uppercase font-bold sticky top-0">
                                                <tr>
                                                    <th className="p-2">Aktion</th>
                                                    <th className="p-2">Datei</th>
                                                    <th className="p-2">Ziel</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {cleanupItems.slice(0, 500).map((it, i) => (
                                                    <tr key={i} className="border-b border-slate-700">
                                                        <td className="p-2 whitespace-nowrap">
                                                            {it.kind === 'rename' && (it.reason === 'doubleExt' ? 'Doppelendung' : it.reason === 'extLowercase' ? 'Endung klein' : 'Umbenennen')}
                                                            {it.kind === 'resolve' && 'DB → Basis + löschen'}
                                                            {it.kind === 'delete' && 'Löschen'}
                                                        </td>
                                                        <td className="p-2 font-mono break-all">{it.from}</td>
                                                        <td className="p-2 font-mono break-all">{it.to || '—'}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        {cleanupItems.length > 500 && (
                                            <div className="p-2 text-[10px] text-slate-500">… und {cleanupItems.length - 500} weitere (werden trotzdem ausgeführt).</div>
                                        )}
                                    </div>
                                )}
                            </div>
                            <div className="p-4 border-t border-slate-700 flex justify-end gap-3 bg-slate-900 rounded-b-lg">
                                <button
                                    onClick={() => { setShowCleanupDialog(false); setShowCleanupList(false); }}
                                    disabled={cleanupRunning}
                                    className="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded text-sm"
                                >
                                    Abbrechen
                                </button>
                                <button
                                    onClick={() => void handleCleanFilenames()}
                                    disabled={cleanupRunning}
                                    className="bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white px-4 py-2 rounded text-sm font-bold"
                                >
                                    {cleanupRunning ? 'Bereinige…' : 'Ausführen (erstellt DB-Backup)'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* F26: Auswahl-Dialog für den Inhalts-Check */}
                {showContentDialog && (
                    <div className="absolute inset-0 bg-black/80 z-20 flex items-center justify-center rounded-lg p-6">
                        <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl max-w-lg w-full p-5">
                            <h4 className="text-lg font-bold text-white mb-2">💾 Inhalt prüfen</h4>
                            <p className="text-xs text-slate-300 mb-4">
                                Der Inhalts-Check liest die Dateien vollständig ein und findet defekte Dateien (0 Bytes/Lesefehler). „Nur Ungeprüfte/Defekte“ ist schnell und prüft {contentSubsetCount} Datei(en); „Alles neu scannen“ liest alle {contentTotalCount} Dateien erneut ein (dauert lange).
                            </p>
                            <div className="flex flex-col gap-2">
                                <button
                                    onClick={() => { setShowContentDialog(false); void runContentCheck(true); }}
                                    disabled={contentSubsetCount === 0}
                                    className="bg-purple-800 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-2 rounded text-sm font-bold text-left"
                                >
                                    ⚡ Nur Ungeprüfte/Defekte ({contentSubsetCount})
                                </button>
                                <button
                                    onClick={() => { setShowContentDialog(false); void runContentCheck(false); }}
                                    className="bg-slate-700 hover:bg-slate-600 text-slate-200 px-4 py-2 rounded text-sm text-left"
                                >
                                    🔍 Alles neu scannen ({contentTotalCount})
                                </button>
                                <button onClick={() => setShowContentDialog(false)} className="text-slate-400 hover:text-white text-xs self-end mt-1">Abbrechen</button>
                            </div>
                        </div>
                    </div>
                )}

                {/* F22: Overlay während der Inhaltsprüfung */}
                {contentRunning && (
                    <div className="absolute inset-0 bg-black/80 z-10 flex flex-col items-center justify-center rounded-lg">
                        <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-purple-500 mb-4"></div>
                        <div className="text-lg font-bold text-white mb-2">Prüfe Datei-Inhalte ({contentTotal > 0 ? Math.round((contentProgress / contentTotal) * 100) : 0}%)...</div>
                        <div className="text-xs text-purple-300 font-mono mb-3 truncate max-w-md">{contentCurrent}</div>
                        <div className="w-80 h-2 bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full bg-purple-500 transition-all duration-300" style={{ width: `${contentTotal > 0 ? (contentProgress / contentTotal) * 100 : 0}%` }}></div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

interface AlbumDownloadModalProps {
    isOpen: boolean;
    onClose: () => void;
    onStart: (folderName: string) => void;
    basePath: string | null;
}

export const AlbumDownloadModal: React.FC<AlbumDownloadModalProps> = ({ isOpen, onClose, onStart, basePath }) => {
    const [folderName, setFolderName] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            setFolderName('');
            setError(null);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const sanitizeName = (name: string): string => {
        return name.replace(/[\\/:*?"<>|]/g, '_').trim();
    };

    const handleStart = () => {
        const sanitized = sanitizeName(folderName);
        if (!sanitized) {
            setError('Bitte gib einen Ordnernamen ein.');
            return;
        }
        setError(null);
        onStart(sanitized);
    };

    const fullPath = basePath ? `${basePath}\\Alben\\${sanitizeName(folderName || 'MeinAlbum')}` : '';

    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[90] p-8">
            <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl max-w-lg w-full flex flex-col">
                <div className="p-4 border-b border-slate-700 flex justify-between items-center bg-purple-900/20">
                    <h3 className="text-lg font-bold text-purple-400">Album-Download</h3>
                </div>

                <div className="p-6 flex flex-col gap-4 bg-slate-900/50">
                    <p className="text-sm text-slate-300 font-bold">
                        Du befindest dich in einem Album oder einer geteilten Sammlung.
                    </p>

                    <div className="bg-amber-900/20 border border-amber-600/50 rounded p-3 text-xs text-slate-300 flex flex-col gap-2">
                        <div className="font-bold text-amber-300">Wichtiger Hinweis</div>
                        <p>
                            Der Album-Download ist eine <strong className="text-amber-200">getrennte Funktion</strong> neben
                            dem eigentlichen Backup und ersetzt dieses nicht:
                        </p>
                        <ul className="list-disc list-inside flex flex-col gap-1 text-slate-300">
                            <li>Die Fotos werden in einen eigenen Ordner geladen: <span className="font-mono text-amber-200">…\Alben\&lt;Name&gt;\</span></li>
                            <li>Sie werden <strong>nicht in die Datenbank</strong> aufgenommen</li>
                            <li>Sie erscheinen <strong>nicht in der Backup-Statistik</strong></li>
                            <li><strong>Duplikate sind beabsichtigt</strong> und kein Fehler – der Album-Ordner kann später unabhängig vom Backup gelöscht werden</li>
                        </ul>
                        <p className="text-slate-400">
                            Das eigentliche Backup solltest du weiterhin aus der Hauptbibliothek durchführen.
                        </p>
                    </div>

                    <div>
                        <label className="block text-xs text-slate-400 font-bold uppercase mb-1">
                            Ordnername
                        </label>
                        <input
                            type="text"
                            value={folderName}
                            onChange={(e) => {
                                setFolderName(e.target.value);
                                setError(null);
                            }}
                            placeholder="z.B. Urlaub_2024"
                            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                            autoFocus
                        />
                        {error && <div className="text-red-400 text-xs mt-1">{error}</div>}
                    </div>

                    {basePath && (
                        <div className="text-xs text-slate-500 font-mono break-all">
                            Ziel: {fullPath}
                        </div>
                    )}
                </div>

                <div className="p-4 border-t border-slate-700 flex justify-end gap-3 bg-slate-800">
                    <button
                        onClick={onClose}
                        className="bg-slate-600 hover:bg-slate-500 text-white px-4 py-2 rounded text-sm"
                    >
                        Abbrechen
                    </button>
                    <button
                        onClick={handleStart}
                        className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded text-sm font-bold shadow"
                    >
                        Download starten
                    </button>
                </div>
            </div>
        </div>
    );
};
