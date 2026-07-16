
import React from 'react';
import iconPath from '../assets/icon.png';

interface StartupScreenProps {
    onLoadDatabase: () => void;
    onNewDatabase: () => void;
}

export const StartupScreen: React.FC<StartupScreenProps> = ({ onLoadDatabase, onNewDatabase }) => {
    return (
        <div className="h-screen w-screen bg-slate-900 text-slate-100 flex items-center justify-center p-8 select-none">
            <div className="bg-slate-800 p-8 rounded-xl shadow-2xl border border-slate-700 max-w-lg w-full text-center">
                 <img src={iconPath} alt="Logo" className="w-16 h-16 mx-auto mb-4" />
                 <h1 className="text-2xl font-bold text-blue-400 mb-2">RLE Google Fotos Backup</h1>
                 <p className="text-slate-400 mb-8 text-sm">Wähle eine Datenbank-Datei (gphotos_db.json) um zu beginnen.</p>
                 
                 <div className="flex flex-col gap-4">
                    <button 
                        onClick={onLoadDatabase} 
                        className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 px-6 rounded-lg shadow transition flex items-center justify-center gap-3"
                    >
                        <span className="text-2xl">📂</span>
                        <div className="text-left">
                            <div className="text-sm font-bold">Vorhandene .json laden</div>
                            <div className="text-xs text-blue-200 opacity-80">Backup fortsetzen</div>
                        </div>
                    </button>

                    <button 
                        onClick={onNewDatabase} 
                        className="bg-slate-700 hover:bg-slate-600 text-slate-200 font-bold py-4 px-6 rounded-lg shadow transition flex items-center justify-center gap-3"
                    >
                        <span className="text-2xl">🆕</span>
                         <div className="text-left">
                            <div className="text-sm font-bold">Neuen Ordner wählen</div>
                            <div className="text-xs text-slate-400 opacity-80">Erstellt gphotos_db.json</div>
                        </div>
                    </button>
                 </div>
                 
                 <div className="mt-8 text-xs text-slate-500">
                    Version 1.0.1 • Alle Daten bleiben lokal.
                 </div>
            </div>
        </div>
    );
};
