
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { DatabaseEntry, IntegrityResult, SkippedDownload, UntrackedFile } from '../types';

type CorrectionTab = 'missing' | 'corrupt' | 'skipped' | 'online' | 'untracked' | 'filenames';

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

    // F22: Prüfungen (aus dem früheren Strukturbericht)
    onCheckDone: (result: IntegrityResult) => void;
    onUpdateFileStatus?: (updates: Record<string, 'ok' | 'corrupt'>) => void;
    onExecuteDuplicates: () => void;
    onCleanLegacy?: () => void;
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
    onDeleteUntrackedFile, onShowUntrackedInExplorer, onOpenUntracked,
    onCheckDone, onUpdateFileStatus, onExecuteDuplicates, onCleanLegacy
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
    const [autoFixNotice, setAutoFixNotice] = useState(''); // F26: kurzer Banner nach Auto-Bereinigung
    const initialCheckStarted = useRef(false); // F26: Struktur-Check automatisch beim Öffnen
    const awaitingResultRef = useRef(false);   // F26: Banner erst nach neuem Ergebnis anzeigen

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
    ];
    // F26: Struktur-Check automatisch beim Öffnen des Fensters
    useEffect(() => {
        if (initialCheckStarted.current) return;
        initialCheckStarted.current = true;
        void runStructureCheck();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // F26: Banner, wenn die Automatik Duplikate/Kollisionsreste entfernt oder Dateien umbenannt hat
    useEffect(() => {
        if (!awaitingResultRef.current || !structureResult?.renamable) return;
        awaitingResultRef.current = false;
        const ar = structureResult.renamable.autoRenamed || 0;
        const as = structureResult.renamable.autoResolved || 0;
        if (ar + as <= 0) return;
        const parts: string[] = [];
        if (ar > 0) parts.push(`${ar} Datei(en) umbenannt`);
        if (as > 0) parts.push(`${as} Duplikat(e)/Kollisionsrest(e) entfernt`);
        setAutoFixNotice(`✅ Automatisch bereinigt: ${parts.join(', ')}.`);
        const t = setTimeout(() => setAutoFixNotice(''), 8000);
        return () => clearTimeout(t);
    }, [structureResult]);

    // F22: Struktur-Check (aus dem früheren Strukturbericht übernommen)
    const runStructureCheck = async () => {
        setStructureRunning(true);
        awaitingResultRef.current = true;
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
                        <div className="text-xs text-slate-400 mt-0.5">Struktur-Check läuft automatisch beim Öffnen · Datenbank, Dateisystem & Dateiinhalte</div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setShowContentDialog(true)}
                            disabled={contentRunning}
                            className="bg-purple-800 hover:bg-purple-700 disabled:opacity-50 text-white px-3 py-2 rounded text-xs border border-purple-600"
                            title="Dateien vollständig lesen und auf Defekte prüfen"
                        >
                            💾 Inhalt prüfen
                        </button>
                        <button onClick={onClose} className="text-slate-400 hover:text-white px-2 text-lg" title="Schließen">✕</button>
                    </div>
                </div>

                {/* STATUSZEILE (Duplikate / Veraltet / letzter Check) */}
                <div className="px-4 py-2 bg-slate-900/60 border-b border-slate-700 flex items-center justify-between gap-3 flex-wrap text-xs">
                    <div className="text-slate-400 flex items-center gap-2">
                        {structureRunning
                            ? <span className="flex items-center gap-2 text-slate-200"><span className="animate-spin rounded-full h-3 w-3 border-t-2 border-slate-200 inline-block"></span> Prüfe Struktur…</span>
                            : structureResult
                                ? <>Letzter Struktur-Check: Duplikate <span className={duplicateCount > 0 ? 'text-amber-400 font-bold' : 'text-slate-300'}>{duplicateCount}</span> · Veraltet <span className={legacyCount > 0 ? 'text-blue-400 font-bold' : 'text-slate-300'}>{legacyCount}</span></>
                                : 'Struktur-Check fehlgeschlagen.'}
                        {contentSummary && <span className="ml-2 text-slate-300">{contentSummary}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                        {duplicateCount > 0 && (
                            <button onClick={onExecuteDuplicates} className="bg-amber-700 hover:bg-amber-600 text-white px-3 py-1 rounded text-[10px] font-bold">Duplikate bereinigen</button>
                        )}
                        {legacyCount > 0 && onCleanLegacy && (
                            <button onClick={onCleanLegacy} className="bg-blue-700 hover:bg-blue-600 text-white px-3 py-1 rounded text-[10px] font-bold">Veraltete Felder bereinigen</button>
                        )}
                    </div>
                </div>

                {/* F26: Banner nach automatischer Bereinigung */}
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
                                Diese Dateien liegen in den Jahres-/Monatsordnern, sind aber keinem DB-Eintrag zugeordnet. Hash-identische „(n)“-Paare werden beim Struktur-Check automatisch aufgelöst (Duplikat gelöscht, Basisname behalten); übrige Reste können hier geprüft oder gelöscht werden.
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
                            </>) : (<TabEmpty text={structureResult ? 'Keine verwaisten Dateien gefunden.' : 'Wird geprüft…'} />)}
                        </div>
                    )}

                    {/* --- SECTION 6: DATEINAMEN (F24, nur Info) --- */}
                    {activeTab === 'filenames' && (
                        <div className="flex flex-col gap-2">
                            <div className="flex justify-between items-center pb-2 border-b border-slate-700">
                                <h4 className="text-lg font-bold text-teal-400">Dateinamen-Prüfung</h4>
                                <div className="text-xs text-slate-400">Nur Information – Bereinigung läuft automatisch</div>
                            </div>
                            <div className="bg-teal-900/10 border border-teal-900/30 p-3 rounded text-xs text-slate-300">
                                Geprüft werden Dateien mit Zähler im Namen („Name (n).ext“). Sichere Umbenennungen und hash-identische Duplikate werden automatisch erledigt; Kollisionen sind zwei verschiedene Fotos mit gleichem Namen und bleiben beide erhalten.
                            </div>

                            {!renameInfo ? (
                                <TabEmpty text={structureRunning ? 'Prüfe Dateinamen…' : 'Keine Daten – Struktur-Check fehlgeschlagen.'} />
                            ) : (
                                <>
                                    <div className="text-[10px] text-slate-500">
                                        Namen mit „(n)“: {renameInfo.stats?.nTotal || 0} · Geschützt: {renameInfo.stats?.legitNames || 0} · Automatisch erledigt: {renameInfo.autoRenamed || 0} umbenannt / {renameInfo.autoResolved || 0} aufgelöst · Kollisionen: {renameInfo.stats?.collisionPair || 0} · Ohne Originalname: {renameInfo.stats?.noName || 0} · Namensabweichung: {renameInfo.stats?.nameMismatch || 0} · Datei fehlt: {renameInfo.stats?.currentMissing || 0}
                                    </div>

                                    {renameDisplayEntries.length === 0 ? (
                                        <TabEmpty text="Keine Einzel-Auffälligkeiten (geschützt/ohne Name/Abweichung/Kollision)." />
                                    ) : (
                                        <div className="border border-slate-700 rounded bg-slate-900/30 max-h-[300px] overflow-y-auto">
                                            <table className="w-full text-left text-xs text-slate-300">
                                                <thead className="bg-slate-800 text-slate-400 uppercase font-bold sticky top-0">
                                                    <tr>
                                                        <th className="p-2">Dateiname</th>
                                                        <th className="p-2">Originalname</th>
                                                        <th className="p-2">Status</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {renameDisplayEntries.map((e, i) => (
                                                        <tr key={i} className="border-b border-slate-700 hover:bg-slate-800/50">
                                                            <td className="p-2 font-mono text-white break-all">{e.currentName}</td>
                                                            <td className="p-2 font-mono text-slate-400 break-all">{e.originalName || '—'}</td>
                                                            <td className="p-2 whitespace-nowrap">
                                                                {e.status === 'protected' && <span className="text-slate-400">Geschützt (echter Google-Name)</span>}
                                                                {e.status === 'noName' && <span className="text-amber-300">Kein Originalname gespeichert</span>}
                                                                {e.status === 'nameMismatch' && <span className="text-orange-300">Originalname passt nicht zum Basisnamen</span>}
                                                                {e.status === 'collision' && <span className="text-red-300">Kollision – „{e.newName}“ ist ein anderes Foto (anderer Inhalt)</span>}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
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
