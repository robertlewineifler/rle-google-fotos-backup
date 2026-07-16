

import React, { useMemo, useState } from 'react';
import { DatabaseEntry } from '../types';
import { getIsoDateString } from '../utils/exifUtils';

interface ScanHeatmapModalProps {
    // ranges: ScannedRange[]; // VERALTET
    scannedDays: Record<string, number>; // NEU: 'YYYY-MM-DD' -> Timestamp
    files: Record<string, DatabaseEntry>;
    onClose: () => void;
}

type ViewMode = 'relative' | 'absolute' | 'density' | 'size';

export const ScanHeatmapModal: React.FC<ScanHeatmapModalProps> = ({ scannedDays, files, onClose }) => {
    const [viewMode, setViewMode] = useState<ViewMode>('relative');

    // 1. Berechne Status-Map, Content-Map und globale Statistiken
    const { sortedYears, contentCounts, stats, sizeMap } = useMemo(() => {
        // Initialisiere mit scannedDays, falls vorhanden
        const safeScannedDays = scannedDays || {};

        const yearsSet = new Set<number>();
        const countsMap = new Map<string, number>(); // 'YYYY-MM-DD' -> Anzahl Fotos
        const sizeMap = new Map<string, number>(); // 'YYYY-MM-DD' -> Bytes total

        let maxCount = 0;
        let maxSize = 0;
        let minScan = Number.MAX_VALUE;
        let maxScan = 0;

        // A) Content Map aufbauen (welche Tage haben Fotos?) & Jahre sammeln
        (Object.values(files) as DatabaseEntry[]).forEach(file => {
             const d = new Date(file.timestamp);
             const key = getIsoDateString(d); 
             
             // Count
             const current = (countsMap.get(key) || 0) + 1;
             countsMap.set(key, current);
             
             // Size (falls vorhanden)
             const currentSize = (sizeMap.get(key) || 0) + (file.size || 0);
             sizeMap.set(key, currentSize);

             yearsSet.add(d.getFullYear());
             if (current > maxCount) maxCount = current;
             if (currentSize > maxSize) maxSize = currentSize;
        });

        // B) Scan-Statistik min/max ermitteln
        Object.values(safeScannedDays).forEach((val) => {
            const ts = val as number;
            if (ts < minScan) minScan = ts;
            if (ts > maxScan) maxScan = ts;
        });
        
        // C) Auch Jahre aus Scan-Historie hinzufügen (falls es Tage gibt, die gescannt wurden aber leer sind - selten, aber möglich)
        Object.keys(safeScannedDays).forEach(dateStr => {
            const y = parseInt(dateStr.split('-')[0], 10);
            if (!isNaN(y)) yearsSet.add(y);
        });

        if (minScan === Number.MAX_VALUE) minScan = 0;

        const sorted = Array.from(yearsSet).sort((a, b) => b - a);

        return { 
            sortedYears: sorted,
            contentCounts: countsMap,
            sizeMap: sizeMap,
            stats: { minScan, maxScan, maxCount, maxSize }
        };
    }, [scannedDays, files]);

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    const getCellColor = (lastScanned: number | undefined, photoCount: number, totalSize: number) => {
        // Basis-Style für "Nicht gescannt" oder "Leer"
        if (!lastScanned && photoCount === 0) return 'bg-slate-800/50'; // Zukunft/Leer
        if (!lastScanned && photoCount > 0) return 'bg-amber-900/40 border border-amber-800'; // Fotos da, aber Tag noch nicht gescannt (Gap)

        // Gescannt, aber 0 Fotos
        if (lastScanned && photoCount === 0) {
             return 'bg-slate-700 border border-slate-600 pattern-striped'; 
        }

        if (viewMode === 'size') {
            // MODE 4: GRÖSSE (GELB)
            if (totalSize === 0) return 'bg-slate-800/50';

            const ratio = totalSize / (stats.maxSize || 1);
            if (ratio < 0.1) return 'bg-yellow-200'; // Wenig Speicher
            if (ratio < 0.3) return 'bg-yellow-400';
            if (ratio < 0.6) return 'bg-yellow-600';
            if (ratio < 0.8) return 'bg-yellow-700';
            return 'bg-yellow-900 border border-yellow-950'; // Riesig
        }

        if (viewMode === 'density') {
            // MODE 3: DICHTE (ROT)
            if (photoCount === 0) return 'bg-slate-800/50';
            
            const ratio = photoCount / (stats.maxCount || 1);
            if (ratio < 0.1) return 'bg-red-300'; // 1 Foto (hell)
            if (ratio < 0.3) return 'bg-red-400';
            if (ratio < 0.5) return 'bg-red-500';
            if (ratio < 0.7) return 'bg-red-700';
            return 'bg-red-900 border border-red-950'; // Viele Fotos (dunkel)
        }

        // Für Mode 1 & 2 brauchen wir das Scan-Datum
        if (!lastScanned) return 'bg-slate-800/50';

        if (viewMode === 'relative') {
            // MODE 1: RELATIV (GRÜN)
            const range = stats.maxScan - stats.minScan;
            if (range === 0) return 'bg-green-500'; // Nur ein Scan-Zeitpunkt vorhanden

            const position = (lastScanned - stats.minScan) / range; // 0.0 (alt) bis 1.0 (neu)

            if (position > 0.9) return 'bg-green-400'; // Neueste
            if (position > 0.7) return 'bg-green-500';
            if (position > 0.5) return 'bg-green-600';
            if (position > 0.25) return 'bg-green-800';
            return 'bg-green-950 border border-green-900'; // Älteste
        }

        if (viewMode === 'absolute') {
            // MODE 2: ABSOLUT (BLAU)
            const now = Date.now();
            const diffMs = now - lastScanned;
            const diffDays = diffMs / (1000 * 60 * 60 * 24);

            if (diffDays < 1) return 'bg-cyan-400'; // Heute
            if (diffDays < 7) return 'bg-cyan-600'; // Woche
            if (diffDays < 30) return 'bg-blue-600'; // Monat
            if (diffDays < 180) return 'bg-blue-800'; // Halbes Jahr
            return 'bg-blue-950 border border-blue-900'; // > 1 Jahr (bzw. älter)
        }

        return 'bg-slate-500'; // Fallback
    };

    const renderYearGrid = (year: number) => {
        const days = [];
        const startOfYear = new Date(year, 0, 1);
        const endOfYear = new Date(year, 11, 31);

        let startDayOfWeek = startOfYear.getDay() - 1; 
        if (startDayOfWeek === -1) startDayOfWeek = 6; 

        for (let i = 0; i < startDayOfWeek; i++) {
            days.push({ type: 'pad', key: `pad-${year}-${i}` });
        }

        let iter = new Date(startOfYear);
        while (iter <= endOfYear) {
            const key = getIsoDateString(iter); 
            // Zugriff direkt auf die Props Map
            const lastScanned = scannedDays ? scannedDays[key] : undefined;
            const photoCount = contentCounts.get(key) || 0;
            const totalSize = sizeMap.get(key) || 0;

            days.push({ 
                type: 'day', 
                key: key, 
                date: new Date(iter), 
                lastScanned,
                photoCount,
                totalSize
            });
            iter.setDate(iter.getDate() + 1);
        }

        return (
            <div className="mb-6">
                <div className="text-xs font-bold text-slate-400 mb-1 ml-1">{year}</div>
                <div 
                    className="grid gap-[2px]" 
                    style={{ 
                        gridTemplateRows: 'repeat(7, 10px)', 
                        gridAutoFlow: 'column', 
                        gridAutoColumns: '10px' 
                    }}
                >
                    {days.map((d: any) => {
                        if (d.type === 'pad') return <div key={d.key} className="bg-transparent" />;
                        
                        let colorClass = getCellColor(d.lastScanned, d.photoCount, d.totalSize);
                        let title = `${d.date.toLocaleDateString()}`;
                        let style = {};

                        // Spezielle Styles für "Gescannt aber leer" (Pattern)
                        if (d.lastScanned && d.photoCount === 0) {
                            colorClass = 'bg-slate-700 border border-slate-600';
                            style = {
                                backgroundImage: 'linear-gradient(45deg, transparent 45%, #000 45%, #000 55%, transparent 55%)',
                                backgroundSize: '10px 10px'
                            };
                        }

                        // Tooltip Info
                        if (d.lastScanned) {
                            const scanDate = new Date(d.lastScanned);
                            title += ` | Fotos: ${d.photoCount} | Größe: ${formatBytes(d.totalSize)} | Scan: ${scanDate.toLocaleDateString()}`;
                        } else if (d.photoCount > 0) {
                            title += ` | Fotos: ${d.photoCount} | Größe: ${formatBytes(d.totalSize)} (Nicht im Scan-Bereich)`;
                        } else {
                            title += ` | (Keine Daten)`;
                        }

                        return (
                            <div 
                                key={d.key} 
                                className={`w-2.5 h-2.5 rounded-[1px] ${colorClass} hover:ring-1 ring-white cursor-help transition-opacity`}
                                title={title}
                                style={style}
                            />
                        );
                    })}
                </div>
            </div>
        );
    };

    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[80] p-8">
            <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl max-w-7xl w-full flex flex-col max-h-[90vh]">
                
                {/* HEADER */}
                <div className="p-4 border-b border-slate-700 bg-slate-900 flex flex-col gap-4">
                    <div className="flex justify-between items-start">
                        <div>
                            <h3 className="text-lg font-bold text-white">Scan-Abdeckung & Verlauf</h3>
                            <p className="text-xs text-slate-400 mt-1">
                                {viewMode === 'relative' && "Zeigt, welche Tage ZULETZT gescannt wurden (im Vergleich zu deinen ältesten Scans). Ideal um alte Scans zu finden."}
                                {viewMode === 'absolute' && "Zeigt das absolute Alter des Scans. Blau verblasst über ein Jahr."}
                                {viewMode === 'density' && "Zeigt, an welchen Tagen die meisten Fotos gespeichert sind. Unabhängig vom Scan-Zeitpunkt."}
                                {viewMode === 'size' && "Zeigt, an welchen Tagen der meiste Speicherplatz verbraucht wird (Bytes)."}
                            </p>
                        </div>
                        <button onClick={onClose} className="text-slate-400 hover:text-white px-2 text-xl">✕</button>
                    </div>

                    <div className="flex bg-slate-800 p-1 rounded-lg self-start border border-slate-700 gap-1">
                        <button 
                            onClick={() => setViewMode('relative')}
                            className={`px-3 py-1.5 rounded text-xs font-bold transition ${viewMode === 'relative' ? 'bg-green-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            1. Relativ (Grün)
                        </button>
                        <button 
                            onClick={() => setViewMode('absolute')}
                            className={`px-3 py-1.5 rounded text-xs font-bold transition ${viewMode === 'absolute' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            2. Absolut (Blau)
                        </button>
                        <button 
                            onClick={() => setViewMode('density')}
                            className={`px-3 py-1.5 rounded text-xs font-bold transition ${viewMode === 'density' ? 'bg-red-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            3. Menge (Rot)
                        </button>
                        <button 
                            onClick={() => setViewMode('size')}
                            className={`px-3 py-1.5 rounded text-xs font-bold transition ${viewMode === 'size' ? 'bg-yellow-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            4. Größe (Gelb)
                        </button>
                    </div>
                </div>
                
                {/* CONTENT */}
                <div className="p-6 bg-slate-900/50 flex-1 overflow-y-auto scrollbar-thin">
                    {sortedYears.length === 0 ? (
                        <div className="text-slate-500 text-center p-8">Keine Scan-Daten verfügbar.</div>
                    ) : (
                        <div className="flex flex-col items-start pl-4">
                            {sortedYears.map(year => (
                                <div key={year}>
                                    {renderYearGrid(year)}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* FOOTER LEGEND */}
                <div className="p-3 border-t border-slate-700 bg-slate-800 text-[10px] text-slate-400 flex flex-wrap justify-end gap-6 items-center">
                     
                     <div className="flex items-center gap-1 opacity-70">
                        <div className="w-2.5 h-2.5 bg-slate-700 border border-slate-600 rounded-[1px]" style={{backgroundImage: 'linear-gradient(45deg, transparent 45%, #000 45%, #000 55%, transparent 55%)'}}></div> 
                        Gescannt (0 Fotos)
                     </div>
                     <div className="h-4 w-[1px] bg-slate-600 mx-2"></div>

                     {viewMode === 'relative' && (
                        <>
                            <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-green-950 border border-green-900 rounded-[1px]"></div> Ältester Scan</div>
                            <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-green-800 rounded-[1px]"></div></div>
                            <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-green-600 rounded-[1px]"></div></div>
                            <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-green-400 rounded-[1px]"></div> Neuester Scan</div>
                        </>
                     )}

                     {viewMode === 'absolute' && (
                        <>
                            <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-blue-950 border border-blue-900 rounded-[1px]"></div> &gt; 1 Jahr</div>
                            <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-blue-800 rounded-[1px]"></div> 6 Mon</div>
                            <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-blue-600 rounded-[1px]"></div> 1 Mon</div>
                            <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-cyan-600 rounded-[1px]"></div> 1 Woche</div>
                            <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-cyan-400 rounded-[1px]"></div> Heute</div>
                        </>
                     )}

                     {viewMode === 'density' && (
                        <>
                             <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-red-300 rounded-[1px]"></div> Wenige</div>
                             <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-red-500 rounded-[1px]"></div></div>
                             <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-red-900 border border-red-950 rounded-[1px]"></div> Viele ({stats.maxCount})</div>
                        </>
                     )}

                     {viewMode === 'size' && (
                        <>
                             <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-yellow-200 rounded-[1px]"></div> Wenig MB</div>
                             <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-yellow-400 rounded-[1px]"></div></div>
                             <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 bg-yellow-900 border border-yellow-950 rounded-[1px]"></div> Viel MB ({formatBytes(stats.maxSize)})</div>
                        </>
                     )}

                </div>
            </div>
        </div>
    );
};