
import React, { useState, useEffect, useMemo } from 'react';
import { DatabaseEntry, IntegrityError, IntegrityResult, RenamableFile } from '../types';

interface CorrectionModalProps {
    orphans: { id: string, entry: DatabaseEntry }[];
    files: Record<string, DatabaseEntry>;
    initialTab?: 'missing' | 'corrupt'; // Kept for API compatibility, but unused
    onClose: () => void;
    
    // Orphan Actions
    onDeleteOrphans: () => void; // Batch delete missing from DB
    onResetOrphans: () => void;
    onShowInFolder: (orphan: { id: string, entry: DatabaseEntry }) => void; // Unused but kept for interface compat if needed
    onNavigate: (id: string) => void; // Navigate to Web

    // Corrupt Actions
    onDeleteCorrupt: (id: string) => void; // Single delete corrupt (disk only)
    onDeleteAllCorrupt: () => void; // Batch delete corrupt (disk only)
}

export const CorrectionModal: React.FC<CorrectionModalProps> = ({ 
    orphans, files, onClose, 
    onDeleteOrphans, onResetOrphans, onNavigate,
    onDeleteCorrupt, onDeleteAllCorrupt
}) => {
    
    // Live-Berechnung der defekten Dateien
    const corruptFiles = useMemo(() => {
        return (Object.entries(files) as [string, DatabaseEntry][])
            .filter(([_, e]) => e.integrityStatus === 'corrupt')
            .map(([id, entry]) => ({ id, entry }));
    }, [files]);

    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[80] p-8">
            <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl max-w-5xl w-full flex flex-col max-h-[90vh]">
                
                {/* HEADER */}
                <div className="p-4 border-b border-slate-700 bg-slate-900 flex justify-between items-center">
                    <h3 className="text-xl font-bold text-white flex items-center gap-2">
                        🛠️ Korrekturen erforderlich
                    </h3>
                    <div className="text-xs text-slate-400">Dateisystem & Datenbank synchronisieren</div>
                </div>
                
                {/* CONTENT AREA - STACKED VIEW */}
                <div className="overflow-y-auto flex-1 bg-slate-800 p-6 flex flex-col gap-8">
                    
                    {/* --- SECTION 1: MISSING FILES (ORPHANS) --- */}
                    {orphans.length > 0 && (
                        <div className="flex flex-col gap-2">
                            <div className="flex justify-between items-center pb-2 border-b border-slate-700">
                                <h4 className="text-lg font-bold text-amber-400">⚠️ Vermisste Dateien ({orphans.length})</h4>
                                <div className="text-xs text-slate-400">In DB, aber nicht auf Festplatte</div>
                            </div>
                            
                            <div className="bg-amber-900/10 border border-amber-900/30 p-3 rounded text-xs text-slate-300">
                                Diese Dateien fehlen lokal. Du kannst sie aus der Datenbank löschen (Cleanup) oder im Webview öffnen, um sie neu herunterzuladen.
                            </div>

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
                        </div>
                    )}

                    {/* --- SECTION 2: CORRUPT FILES --- */}
                    {corruptFiles.length > 0 && (
                        <div className="flex flex-col gap-2">
                            <div className="flex justify-between items-center pb-2 border-b border-slate-700">
                                <h4 className="text-lg font-bold text-red-400">❌ Defekte Dateien ({corruptFiles.length})</h4>
                                <div className="text-xs text-slate-400">0 Bytes oder Lesefehler</div>
                            </div>

                            <div className="bg-red-900/10 border border-red-900/30 p-3 rounded text-xs text-slate-300">
                                Diese Dateien sind kaputt. Lösche sie von der Festplatte, damit sie beim nächsten Durchlauf automatisch neu geladen werden.
                            </div>

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
                                                        onClick={() => onNavigate(item.id)}
                                                        className="bg-blue-700 hover:bg-blue-600 text-white px-2 py-1 rounded text-[10px]"
                                                        title="Im Browser öffnen"
                                                    >
                                                        🌐 Web
                                                    </button>
                                                    <button 
                                                        onClick={() => onDeleteCorrupt(item.id)} 
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
                                    onClick={onDeleteAllCorrupt}
                                    className="bg-red-800 hover:bg-red-700 text-white px-4 py-2 rounded text-sm font-bold shadow border border-red-600"
                                >
                                    Alle {corruptFiles.length} von Festplatte löschen (Re-Download Planen)
                                </button>
                            </div>
                        </div>
                    )}

                    {orphans.length === 0 && corruptFiles.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-40 text-slate-500 opacity-50">
                            <div className="text-4xl mb-2">✨</div>
                            <div>Alles sauber. Keine Probleme gefunden.</div>
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
            </div>
        </div>
    );
};

interface IntegrityReportModalProps {
    initialResult: IntegrityResult | null;
    basePath: string;
    files: Record<string, DatabaseEntry>;
    onClose: () => void;
    onCheckDone: (result: IntegrityResult) => void;
    onExecuteDuplicates: () => void;
    onShowMissing: () => void;
    onCleanLegacy?: () => void;
    onUpdateFileStatus?: (updates: Record<string, 'ok' | 'corrupt'>) => void;
    onDeleteCorruptFile?: (id: string) => Promise<boolean>;
}

type ModalMode = 'menu' | 'structure_running' | 'structure_result' | 'content_dashboard' | 'content_running' | 'content_result';

export const IntegrityReportModal: React.FC<IntegrityReportModalProps> = ({ 
    initialResult, basePath, files, onClose, onCheckDone, onExecuteDuplicates, 
    onShowMissing, onCleanLegacy, onUpdateFileStatus, onDeleteCorruptFile 
}) => {
    
    // Status Logic
    const [mode, setMode] = useState<ModalMode>(initialResult ? 'structure_result' : 'menu');
    const [structureResult, setStructureResult] = useState<IntegrityResult | null>(initialResult);
    
    // Content Check State
    const [progress, setProgress] = useState(0);
    const [totalToCheck, setTotalToCheck] = useState(0);
    const [currentScannedFile, setCurrentScannedFile] = useState<string>(""); 
    const [corruptFiles, setCorruptFiles] = useState<{id: string, entry: DatabaseEntry}[]>([]);
    
    // Refresh Trigger erzwingt Neuberechnung der Stats
    const [refreshTrigger, setRefreshTrigger] = useState(0); 

    // Calculate Stats for Dashboard
    const stats = useMemo(() => {
        const values = Object.values(files) as DatabaseEntry[];
        return {
            total: values.length,
            ok: values.filter((f: DatabaseEntry) => f.integrityStatus === 'ok').length,
            corrupt: values.filter((f: DatabaseEntry) => f.integrityStatus === 'corrupt').length,
            unchecked: values.filter((f: DatabaseEntry) => !f.integrityStatus).length
        };
    }, [files, refreshTrigger]); 

    // 1. STRUKTUR-CHECK (Existing)
    const runStructureCheck = async (onlySubset: boolean = false) => {
        setMode('structure_running');
        try {
             // Pass flag to backend
             // @ts-ignore - Argument extension in main/preload
             const result = await window.electron.checkIntegrity(basePath, files, onlySubset);
             setStructureResult(result);
             
             // Legacy count extrahieren
             let legacyCount = 0;
             if (files['scannedRanges' as any]) legacyCount++; 
             const validKeys = new Set([
                  'filename', 'timestamp', 'originalDate', 'originalName', 
                  'savedAt', 'downloadedAt', 'scannedAt', 'hash', 'missingSince', 'id',
                  'integrityStatus', 'integrityCheckedAt'
             ]);
             for(const id in files) {
                  const entry = files[id];
                  for(const key in entry) {
                      if(!validKeys.has(key)) { legacyCount++; break; }
                  }
             }
             result.legacyCount = legacyCount;

             onCheckDone(result);
             setMode('structure_result');
        } catch (e) {
            console.error(e);
            alert("Fehler bei Strukturprüfung");
            setMode('menu');
        }
    };

    const prepareContentDashboard = () => {
        // Load known corrupt files for display
        const knownCorrupt = (Object.entries(files) as [string, DatabaseEntry][])
            .filter(([_, e]) => e.integrityStatus === 'corrupt')
            .map(([id, entry]) => ({ id, entry }));
        setCorruptFiles(knownCorrupt);
        setMode('content_dashboard');
    };

    // 2. INHALTS-CHECK (New)
    const runContentCheck = async (onlySubset: boolean) => {
        setMode('content_running');
        setProgress(0);
        setCurrentScannedFile("");
        setCorruptFiles([]); 
        
        const rawEntries = Object.entries(files) as [string, DatabaseEntry][];
        let allEntries: {id: string; entry: DatabaseEntry}[] = rawEntries.map(([id, entry]) => ({id, entry}));
        
        // FILTER LOGIC
        if (onlySubset) {
            allEntries = allEntries.filter(item => item.entry.integrityStatus !== 'ok');
        }

        setTotalToCheck(allEntries.length);
        
        if (allEntries.length === 0) {
            alert("Keine Dateien im gewählten Filter (alle sind OK).");
            setMode('content_dashboard');
            return;
        }
        
        // Chunk Processing (Batch)
        const CHUNK_SIZE = 20;
        let processed = 0;
        let foundCorrupt: {id: string, entry: DatabaseEntry}[] = [];
        const statusUpdates: Record<string, 'ok' | 'corrupt'> = {};

        for (let i = 0; i < allEntries.length; i += CHUNK_SIZE) {
            const chunk = allEntries.slice(i, i + CHUNK_SIZE);
            if (chunk.length > 0) setCurrentScannedFile(chunk[0].entry.filename);
            const payload = chunk.map(c => ({ id: c.id, filename: c.entry.filename, timestamp: c.entry.timestamp }));
            
            try {
                const results = await window.electron.verifyFileIntegrityBatch(basePath, payload);
                Object.entries(results).forEach(([id, status]) => {
                    statusUpdates[id] = status;
                    if (files[id]) { files[id].integrityStatus = status; }
                    if (status === 'corrupt') {
                        const entry = files[id];
                        if (entry) foundCorrupt.push({ id, entry });
                    }
                });
                setRefreshTrigger(prev => prev + 1);
            } catch (e) { console.error("Batch fail", e); }
            processed += chunk.length;
            setProgress(processed);
            await new Promise(r => setTimeout(r, 10));
        }
        
        if (onUpdateFileStatus) onUpdateFileStatus(statusUpdates);
        setCorruptFiles(foundCorrupt);
        setMode('content_result');
    };

    const handleDeleteCorrupt = async (id: string) => {
        if (!onDeleteCorruptFile) return;
        const success = await onDeleteCorruptFile(id);
        if (success) {
            setCorruptFiles(prev => prev.filter(p => p.id !== id));
            setRefreshTrigger(prev => prev + 1); 
        }
    };

    // RENDER LOGIC
    
    // --- MODE: MENU ---
    if (mode === 'menu') {
        return (
            <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[80] p-8">
              <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl max-w-2xl w-full flex flex-col p-6">
                 <h3 className="text-xl font-bold text-white mb-2">Datenbank & Dateien prüfen</h3>
                 <p className="text-slate-400 text-sm mb-6">Wähle eine Prüfmethode aus. Die Prüfungen laufen lokal auf deinem Computer.</p>
                 
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                     <button onClick={() => runStructureCheck(false)} className="bg-slate-700 hover:bg-slate-600 border border-slate-600 p-6 rounded-lg text-left group transition">
                         <div className="text-2xl mb-2 group-hover:scale-110 transition-transform origin-left">🏗️</div>
                         <div className="font-bold text-blue-300 mb-1">Struktur prüfen</div>
                         <div className="text-xs text-slate-400">Prüft alle Dateien auf fehlende Dateien (Missing) und Duplikate.</div>
                     </button>

                     <button onClick={prepareContentDashboard} className="bg-slate-700 hover:bg-slate-600 border border-slate-600 p-6 rounded-lg text-left group transition">
                         <div className="text-2xl mb-2 group-hover:scale-110 transition-transform origin-left">💾</div>
                         <div className="font-bold text-purple-300 mb-1">Inhalt prüfen (Integrität)</div>
                         <div className="text-xs text-slate-400">Deep Scan: Liest komplette Dateien. Findet "Datei kann nicht gelesen werden" Fehler & defekte JPEGs.</div>
                     </button>
                 </div>

                 <div className="mt-8 flex justify-end">
                     <button onClick={onClose} className="text-slate-400 hover:text-white text-sm px-4 py-2">Abbrechen</button>
                 </div>
              </div>
            </div>
        );
    }

    // --- MODE: CONTENT DASHBOARD (Only Stats) ---
    if (mode === 'content_dashboard') {
        return (
             <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[80] p-8">
              <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl max-w-4xl w-full flex flex-col max-h-[90vh]">
                  <div className="p-4 border-b border-slate-700 flex justify-between items-center bg-purple-900/20">
                      <h3 className="text-lg font-bold text-purple-400">Inhalts-Prüfung Dashboard</h3>
                      <div className="text-xs text-slate-400">Gesamt: {stats.total} Dateien</div>
                  </div>
                  
                  {/* Stats Bar */}
                  <div className="grid grid-cols-3 gap-2 p-4 bg-slate-900 border-b border-slate-700">
                      <div className="bg-slate-800 p-2 rounded text-center border border-green-900/30">
                          <div className="text-[10px] uppercase text-slate-500 font-bold">Intakt (OK)</div>
                          <div className="text-xl font-bold text-green-400">{stats.ok}</div>
                      </div>
                      <div className={`bg-slate-800 p-2 rounded text-center border ${stats.corrupt > 0 ? 'border-red-500 bg-red-900/20' : 'border-transparent'}`}>
                          <div className="text-[10px] uppercase text-slate-500 font-bold">Defekt</div>
                          <div className={`text-xl font-bold ${stats.corrupt > 0 ? 'text-red-400' : 'text-slate-400'}`}>{stats.corrupt}</div>
                      </div>
                      <div className="bg-slate-800 p-2 rounded text-center border border-transparent">
                          <div className="text-[10px] uppercase text-slate-500 font-bold">Ungeprüft</div>
                          <div className="text-xl font-bold text-slate-300">{stats.unchecked}</div>
                      </div>
                  </div>

                  {/* INFO Area */}
                  <div className="p-8 flex flex-col items-center justify-center text-slate-400 opacity-80 gap-2 bg-slate-900/50 flex-1">
                      <div className="text-3xl">💽</div>
                      <div className="text-sm">Starten Sie einen Scan, um defekte Dateien zu finden.</div>
                      {stats.corrupt > 0 && <div className="text-red-400 text-xs font-bold mt-2">Bereits {stats.corrupt} defekte Dateien bekannt!</div>}
                  </div>

                  <div className="p-4 border-t border-slate-700 bg-slate-800 flex flex-col gap-3">
                      <div className="grid grid-cols-2 gap-4">
                            <button 
                                onClick={() => runContentCheck(true)} 
                                className="bg-slate-700 hover:bg-purple-600 hover:text-white text-slate-200 py-3 px-4 rounded border border-slate-600 flex flex-col items-start transition group"
                            >
                                <span className="text-sm font-bold flex items-center gap-2">⚡ Nur Ungeprüfte / Defekte scannen</span>
                                <span className="text-[10px] opacity-70 group-hover:opacity-100">
                                    Prüft {stats.unchecked + stats.corrupt} Dateien. Überspringt {stats.ok} bereits intakte Dateien.
                                </span>
                            </button>

                            <button 
                                onClick={() => runContentCheck(false)} 
                                className="bg-slate-900 hover:bg-blue-600 hover:text-white text-slate-400 hover:border-transparent py-3 px-4 rounded border border-slate-700 flex flex-col items-start transition group"
                            >
                                <span className="text-sm font-bold flex items-center gap-2">🔍 ALLES neu scannen</span>
                                <span className="text-[10px] opacity-70 group-hover:opacity-100">
                                    Dauert lange! Liest alle {stats.total} Dateien erneut komplett ein.
                                </span>
                            </button>
                      </div>
                      <div className="flex justify-start">
                          <button onClick={() => setMode('menu')} className="text-slate-400 hover:text-white text-sm">Zurück</button>
                      </div>
                  </div>
              </div>
            </div>
        );
    }

    // --- MODE: RUNNING (Generic) ---
    if (mode === 'structure_running' || mode === 'content_running') {
        const percent = totalToCheck > 0 ? Math.round((progress / totalToCheck) * 100) : 0;
        return (
            <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[80] p-8">
                 <div className="bg-slate-800 p-8 rounded-lg shadow-2xl flex flex-col items-center max-w-lg w-full">
                      <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-blue-500 mb-4"></div>
                      <div className="text-lg font-bold text-white mb-2">
                          {mode === 'structure_running' ? 'Prüfe Datenbank-Struktur...' : `Prüfe Datei-Inhalte (${percent}%)...`}
                      </div>
                      
                      {currentScannedFile && (
                          <div className="text-xs text-blue-300 font-mono mb-2 truncate max-w-full opacity-80">
                              {currentScannedFile}
                          </div>
                      )}

                      {mode === 'content_running' && (
                          <div className="w-full h-2 bg-slate-700 rounded-full mt-2 overflow-hidden">
                              <div className="h-full bg-blue-500 transition-all duration-300" style={{width: `${percent}%`}}></div>
                          </div>
                      )}
                 </div>
            </div>
        );
    }
    
    // --- MODE: STRUCTURE RESULT (Old Logic) ---
    if (mode === 'structure_result' && structureResult) {
        const result = structureResult;
        const duplicates = result.duplicates || [];
        const missingCount = result.missing.length;
        const legacyCount = result.legacyCount || 0;
        const isClean = duplicates.length === 0 && missingCount === 0 && legacyCount === 0;

        return (
            <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[80] p-8">
              <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl max-w-3xl w-full flex flex-col max-h-[90vh]">
                  <div className={`p-4 border-b border-slate-700 flex justify-between items-center ${isClean ? 'bg-green-900/20' : 'bg-amber-900/20'}`}>
                      <h3 className={`text-lg font-bold ${isClean ? 'text-green-400' : 'text-amber-400'}`}>Struktur Bericht</h3>
                      <div className="text-xs text-slate-400">Geprüft: {result.total} Einträge</div>
                  </div>
                  
                  {/* Summary Grid */}
                  <div className="grid grid-cols-3 gap-2 p-4 bg-slate-900 border-b border-slate-700">
                      <div className={`bg-slate-800 p-2 rounded text-center border ${missingCount > 0 ? 'border-red-900/50 bg-red-900/10' : 'border-transparent'}`}>
                          <div className="text-[10px] uppercase text-slate-500 font-bold">Vermisst</div>
                          <div className={`text-xl font-bold ${missingCount > 0 ? 'text-red-400' : 'text-slate-400'}`}>{missingCount}</div>
                      </div>
                      <div className={`bg-slate-800 p-2 rounded text-center border ${duplicates.length > 0 ? 'border-amber-900/50 bg-amber-900/10' : 'border-transparent'}`}>
                          <div className="text-[10px] uppercase text-slate-500 font-bold">Duplikate</div>
                          <div className={`text-xl font-bold ${duplicates.length > 0 ? 'text-amber-400' : 'text-slate-400'}`}>{duplicates.length}</div>
                      </div>
                      <div className={`bg-slate-800 p-2 rounded text-center border ${legacyCount > 0 ? 'border-blue-900/50 bg-blue-900/10' : 'border-transparent'}`}>
                          <div className="text-[10px] uppercase text-slate-500 font-bold">Veraltet</div>
                          <div className={`text-xl font-bold ${legacyCount > 0 ? 'text-blue-400' : 'text-slate-400'}`}>{legacyCount}</div>
                      </div>
                  </div>

                  <div className="p-4 overflow-y-auto flex-1 bg-slate-900/30">
                      {isClean ? (
                          <div className="flex flex-col items-center justify-center h-full text-slate-500 py-10">
                              <div className="text-4xl mb-2">✅</div>
                              <div className="font-bold text-lg text-slate-300">Struktur OK</div>
                              <div className="text-xs">Keine Duplikate oder fehlende Dateien.</div>
                          </div>
                      ) : (
                          <div className="flex flex-col gap-4">
                              {legacyCount > 0 && (
                                  <div className="bg-blue-900/20 border border-blue-900 p-3 rounded flex justify-between items-center">
                                      <div><div className="text-sm font-bold text-blue-300">Veraltete Datenfelder ({legacyCount})</div></div>
                                      {onCleanLegacy && <button onClick={onCleanLegacy} className="bg-blue-700 hover:bg-blue-600 text-white text-xs px-3 py-2 rounded">Bereinigen</button>}
                                  </div>
                              )}
                              {duplicates.length > 0 && <p className="text-sm text-slate-300">Gefundene Duplikat-Gruppen: {duplicates.length}</p>}
                          </div>
                      )}
                  </div>

                  <div className="p-4 border-t border-slate-700 flex justify-between gap-3 bg-slate-800">
                      <button onClick={() => setMode('menu')} className="text-slate-400 hover:text-white px-4 py-2 text-sm">Zurück</button>
                      <div className="flex gap-2">
                        {missingCount > 0 && <button onClick={onShowMissing} className="bg-red-700 hover:bg-red-600 text-white px-4 py-2 rounded text-sm font-bold">Vermisste anzeigen</button>}
                        {duplicates.length > 0 && <button onClick={onExecuteDuplicates} className="bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded text-sm font-bold">Duplikate bereinigen</button>}
                        <button onClick={onClose} className="bg-slate-600 hover:bg-slate-500 text-white px-4 py-2 rounded text-sm">Schließen</button>
                      </div>
                  </div>
              </div>
            </div>
        );
    }

    // --- MODE: CONTENT RESULT (Batch Results only) ---
    if (mode === 'content_result') {
        return (
            <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[80] p-8">
              <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl max-w-4xl w-full flex flex-col max-h-[90vh]">
                  <div className="p-4 border-b border-slate-700 flex justify-between items-center bg-purple-900/20">
                      <h3 className="text-lg font-bold text-purple-400">Inhalts-Prüfung Ergebnisse</h3>
                      <div className="text-xs text-slate-400">Geprüft: {totalToCheck}</div>
                  </div>
                  
                  <div className="p-4 overflow-y-auto flex-1 bg-slate-900/50">
                      {corruptFiles.length === 0 ? (
                           <div className="flex flex-col items-center justify-center h-full text-slate-500 py-10">
                              <div className="text-4xl mb-2">✅</div>
                              <div className="font-bold text-lg text-slate-300">Alle geprüften Dateien lesbar</div>
                              <div className="text-xs">Keine defekten Dateien in diesem Durchlauf gefunden.</div>
                           </div>
                      ) : (
                          <>
                            <div className="bg-red-900/20 border border-red-500 p-4 rounded mb-4">
                                <h4 className="font-bold text-red-300 mb-1">⚠️ {corruptFiles.length} defekte Dateien gefunden</h4>
                                <p className="text-xs text-slate-300">Diese Dateien haben 0 Bytes, enden abrupt (Download abgebrochen) oder haben defekte Sektoren.</p>
                            </div>
                            <table className="w-full text-left text-xs text-slate-300">
                                <thead className="bg-slate-800 text-slate-400 uppercase font-bold sticky top-0">
                                    <tr>
                                        <th className="p-2">Name</th>
                                        <th className="p-2">Datum</th>
                                        <th className="p-2 text-right">Aktion</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {corruptFiles.map((item, idx) => (
                                        <tr key={idx} className="border-b border-slate-700 hover:bg-slate-800/50">
                                            <td className="p-2 font-mono text-red-200">{item.entry.filename}</td>
                                            <td className="p-2">{new Date(item.entry.timestamp).toLocaleDateString()}</td>
                                            <td className="p-2 text-right">
                                                <button onClick={() => handleDeleteCorrupt(item.id)} className="bg-red-700 hover:bg-red-600 text-white px-2 py-1 rounded text-[10px]">Löschen</button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                          </>
                      )}
                  </div>

                  <div className="p-4 border-t border-slate-700 flex justify-between bg-slate-800">
                      <button onClick={() => setMode('content_dashboard')} className="text-slate-400 hover:text-white px-4 py-2 text-sm">Zurück zum Dashboard</button>
                      <button onClick={onClose} className="bg-slate-600 hover:bg-slate-500 text-white px-4 py-2 rounded text-sm">Schließen</button>
                  </div>
              </div>
            </div>
        );
    }
    
    return null;
};

interface RenameModalProps {
    candidates: RenamableFile[];
    onClose: () => void;
    onExecute: () => void;
}

export const RenameModal: React.FC<RenameModalProps> = ({ candidates, onClose, onExecute }) => {
    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[80] p-8">
            <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl max-w-2xl w-full flex flex-col max-h-[90vh]">
                <div className="p-4 border-b border-slate-700 flex justify-between items-center bg-blue-900/20">
                    <h3 className="text-lg font-bold text-blue-400">Dateinamen bereinigen ({candidates.length})</h3>
                </div>

                <div className="p-4 overflow-y-auto flex-1 bg-slate-900/50">
                    <p className="text-sm text-slate-300 mb-4">
                        Folgende Dateien haben einen Zähler im Namen (z.B. (1)), obwohl die Original-Datei nicht existiert.
                        Sie können sicher umbenannt werden, um den "sauberen" Namen wiederherzustellen.
                    </p>
                    <table className="w-full text-left text-xs text-slate-300">
                        <thead className="bg-slate-800 text-slate-400 uppercase font-bold sticky top-0">
                            <tr>
                                <th className="p-2">Aktueller Name</th>
                                <th className="p-2">➔</th>
                                <th className="p-2">Neuer Name</th>
                            </tr>
                        </thead>
                        <tbody>
                            {candidates.map((item, idx) => (
                                <tr key={idx} className="border-b border-slate-700 hover:bg-slate-800/50">
                                    <td className="p-2 font-mono text-amber-200">{item.currentName}</td>
                                    <td className="p-2 text-slate-500">➔</td>
                                    <td className="p-2 font-mono text-green-400 font-bold">{item.newName}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className="p-4 border-t border-slate-700 flex justify-end gap-3 bg-slate-800">
                    <button
                        onClick={onClose}
                        className="bg-slate-600 hover:bg-slate-500 text-white px-4 py-2 rounded text-sm"
                    >
                        Abbrechen
                    </button>
                    <button
                        onClick={onExecute}
                        className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded text-sm font-bold shadow"
                    >
                        Alle umbenennen
                    </button>
                </div>
            </div>
        </div>
    );
};
