import { GooglePhotoAlbum, GoogleMediaItem } from '../types';

const BASE_URL = 'https://photoslibrary.googleapis.com/v1';

export const checkTokenInfo = async (accessToken: string) => {
    // Dieser Call kann im Browser bleiben, da googleapis.com/oauth2 meist CORS erlaubt.
    // Falls nicht, könnte man ihn auch proxyn.
  try {
    const response = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${accessToken}`);
    return await response.json();
  } catch (e) {
    console.error("Token Check fehlgeschlagen", e);
    return { error: "Check failed" };
  }
};

export const listAlbums = async (accessToken: string): Promise<GooglePhotoAlbum[]> => {
  let albums: GooglePhotoAlbum[] = [];
  let nextPageToken: string | undefined = undefined;

  do {
    // URL Aufbau ohne window.location.origin
    const urlObj = new URL(`${BASE_URL}/albums`);
    urlObj.searchParams.append('pageSize', '50');
    if (nextPageToken) {
      urlObj.searchParams.append('pageToken', nextPageToken);
    }

    try {
        const result: any = await window.electron.googleApiRequest(urlObj.toString(), {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            },
        });

        if (!result.success) {
            const bodyStr = result.body ? JSON.stringify(result.body, null, 2) : (result.error || result.statusText);
            throw new Error(`API Fehler (${result.status}): ${bodyStr}`);
        }

        const data = result.data;
        if (data && data.albums) {
            albums = [...albums, ...data.albums];
        }
        nextPageToken = data ? data.nextPageToken : undefined;

    } catch (err: any) {
        console.error("ListAlbums Fehler:", err);
        throw err; // Re-throw, damit die App.tsx es anzeigen kann
    }

  } while (nextPageToken);

  return albums;
};

export const listMediaItemsInAlbum = async (
  accessToken: string,
  albumId: string
): Promise<GoogleMediaItem[]> => {
  let mediaItems: GoogleMediaItem[] = [];
  let nextPageToken: string | undefined = undefined;

  do {
    try {
        const result: any = await window.electron.googleApiRequest(`${BASE_URL}/mediaItems:search`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                albumId: albumId,
                pageSize: 100,
                pageToken: nextPageToken,
            }),
        });

        if (!result.success) {
             const bodyStr = result.body ? JSON.stringify(result.body, null, 2) : (result.error || result.statusText);
             throw new Error(`API Fehler (${result.status}): ${bodyStr}`);
        }

        const data = result.data;
        if (data && data.mediaItems) {
            mediaItems = [...mediaItems, ...data.mediaItems];
        }
        nextPageToken = data ? data.nextPageToken : undefined;

    } catch (err: any) {
        console.error("ListMediaItems Fehler:", err);
        throw err;
    }
  } while (nextPageToken);

  return mediaItems;
};

export const downloadImageAsBlob = async (url: string): Promise<Blob> => {
  const downloadUrl = `${url}=d`; 
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Konnte Bilddaten nicht laden (${response.status})`);
  }
  return await response.blob();
};