/**
 * Messages the server sends to people (errors, update progress), in every language the app speaks.
 * They are kept as keys and translated when sent, so each device gets its own language.
 */

export type Lang = "en" | "fr" | "es";
type Params = Record<string, string | number>;

const en = {
  invalidVideoId: "Invalid video ID.",
  emptyQuery: "Type something to search.",
  missingTitle: "Give the song's title.",
  notBackup: "This file isn't a Musike backup.",
  newerBackup: "This backup was made by a newer Musike. Update the app to import it.",
  idMismatch: "The ID doesn't match.",
  tracksRequired: "Send a list of tracks.",
  invalidGenre: "Invalid genre.",
  invalidOffset: "Invalid position.",
  invalidArtist: "Invalid artist.",
  routeNotFound: "Route not found.",
  noFreePort: "No free port between {from} and {to}.",
  invalidTrack: "Invalid track.",
  playlistNotFound: "Playlist not found.",
  playlistNameRequired: "Give the playlist a name.",
  genresUnavailable: "Couldn't load the genres right now. Try again.",
  genreUnavailable: "Couldn't open this genre right now. Try again.",
  genreEmpty: "Nothing found for this genre.",
  artistUnavailable: "Couldn't open this artist right now. Try again.",
  artistNotFound: "Artist not found.",
  albumUnavailable: "Couldn't open this album right now. Try again.",
  albumNotFound: "Album not found.",
  invalidAlbum: "Invalid album.",
  ytdlpMissing: "yt-dlp wasn't found on this computer. Open Settings in Musike to install it.",
  ytdlpTimeout: "yt-dlp took too long to answer.",
  ytdlpCantRun: "Couldn't run yt-dlp ({error}). Open Settings in Musike.",
  botCheck: "YouTube is asking this connection to prove it's not a bot. If you're on a VPN, turn it off and try again.",
  videoUnavailable: "This video isn't available on YouTube.",
  ageRestricted: "Age-restricted video. It needs cookies from a signed-in account.",
  ytdlpFailed: "yt-dlp failed.",
  ytdlpOutdated: "{detail} YouTube may have changed: update yt-dlp in Settings.",
  noAudio: "No audio format available for this video.",
  noSdVideo: "This video has no combined SD version. Use HD.",
  streamRefused: "YouTube refused the stream (HTTP {status}). Try updating yt-dlp in Settings.",
  noWinget: "yt-dlp wasn't found and winget isn't available. Install it manually: https://github.com/yt-dlp/yt-dlp",
  installingYtdlp: "Installing yt-dlp",
  updatingYtdlp: "Updating yt-dlp",
  directUpdateFailed: "Direct update failed, trying winget",
  downloadingTools: "Downloading yt-dlp and Deno from GitHub",
  alreadyLatest: "Already on the latest version ({version})",
  ytdlpReady: "yt-dlp {version} is ready to use",
  updateFailed: "Couldn't update yt-dlp.",
  toolMissing: "{tool} wasn't found on this computer.",
  downloadFailed: "Downloading {tool} failed (HTTP {status}).",
  ffmpegPackage: "Unexpected FFmpeg package.",
};

export type MsgKey = keyof typeof en;

const fr: Record<MsgKey, string> = {
  invalidVideoId: "ID de vidéo invalide.",
  emptyQuery: "Saisissez quelque chose à rechercher.",
  missingTitle: "Indiquez le titre de la chanson.",
  notBackup: "Ce fichier n'est pas une sauvegarde Musike.",
  newerBackup: "Cette sauvegarde vient d'une version plus récente de Musike. Mettez l'app à jour pour l'importer.",
  idMismatch: "L'ID ne correspond pas.",
  tracksRequired: "Envoyez une liste de pistes.",
  invalidGenre: "Genre invalide.",
  invalidOffset: "Position invalide.",
  invalidArtist: "Artiste invalide.",
  routeNotFound: "Route introuvable.",
  noFreePort: "Aucun port libre entre {from} et {to}.",
  invalidTrack: "Piste invalide.",
  playlistNotFound: "Playlist introuvable.",
  playlistNameRequired: "Donnez un nom à la playlist.",
  genresUnavailable: "Impossible de charger les genres pour le moment. Réessayez.",
  genreUnavailable: "Impossible d'ouvrir ce genre pour le moment. Réessayez.",
  genreEmpty: "Rien trouvé pour ce genre.",
  artistUnavailable: "Impossible d'ouvrir cet artiste pour le moment. Réessayez.",
  artistNotFound: "Artiste introuvable.",
  albumUnavailable: "Impossible d'ouvrir cet album pour le moment. Réessayez.",
  albumNotFound: "Album introuvable.",
  invalidAlbum: "Album invalide.",
  ytdlpMissing: "yt-dlp est introuvable sur cet ordinateur. Ouvrez les Réglages de Musike pour l'installer.",
  ytdlpTimeout: "yt-dlp a mis trop de temps à répondre.",
  ytdlpCantRun: "Impossible d'exécuter yt-dlp ({error}). Ouvrez les Réglages de Musike.",
  botCheck: "YouTube demande à cette connexion de prouver qu'elle n'est pas un robot. Si vous utilisez un VPN, désactivez-le et réessayez.",
  videoUnavailable: "Cette vidéo n'est pas disponible sur YouTube.",
  ageRestricted: "Vidéo réservée aux adultes. Elle nécessite les cookies d'un compte connecté.",
  ytdlpFailed: "Échec de yt-dlp.",
  ytdlpOutdated: "{detail} YouTube a peut-être changé : mettez yt-dlp à jour dans les Réglages.",
  noAudio: "Aucun format audio disponible pour cette vidéo.",
  noSdVideo: "Cette vidéo n'a pas de version SD combinée. Utilisez la HD.",
  streamRefused: "YouTube a refusé le flux (HTTP {status}). Essayez de mettre yt-dlp à jour dans les Réglages.",
  noWinget: "yt-dlp est introuvable et winget n'est pas disponible. Installez-le manuellement : https://github.com/yt-dlp/yt-dlp",
  installingYtdlp: "Installation de yt-dlp",
  updatingYtdlp: "Mise à jour de yt-dlp",
  directUpdateFailed: "La mise à jour directe a échoué, tentative via winget",
  downloadingTools: "Téléchargement de yt-dlp et Deno depuis GitHub",
  alreadyLatest: "Déjà à la dernière version ({version})",
  ytdlpReady: "yt-dlp {version} est prêt à l'emploi",
  updateFailed: "Impossible de mettre à jour yt-dlp.",
  toolMissing: "{tool} est introuvable sur cet ordinateur.",
  downloadFailed: "Le téléchargement de {tool} a échoué (HTTP {status}).",
  ffmpegPackage: "Paquet FFmpeg inattendu.",
};

const es: Record<MsgKey, string> = {
  invalidVideoId: "ID de vídeo no válido.",
  emptyQuery: "Escribe algo para buscar.",
  missingTitle: "Indica el título de la canción.",
  notBackup: "Este archivo no es una copia de Musike.",
  newerBackup: "Esta copia se creó con una versión más reciente de Musike. Actualiza la app para importarla.",
  idMismatch: "El ID no coincide.",
  tracksRequired: "Envía una lista de pistas.",
  invalidGenre: "Género no válido.",
  invalidOffset: "Posición no válida.",
  invalidArtist: "Artista no válido.",
  routeNotFound: "Ruta no encontrada.",
  noFreePort: "No hay ningún puerto libre entre {from} y {to}.",
  invalidTrack: "Pista no válida.",
  playlistNotFound: "Lista no encontrada.",
  playlistNameRequired: "Ponle un nombre a la lista.",
  genresUnavailable: "No se pudieron cargar los géneros ahora. Inténtalo de nuevo.",
  genreUnavailable: "No se pudo abrir este género ahora. Inténtalo de nuevo.",
  genreEmpty: "No se encontró nada para este género.",
  artistUnavailable: "No se pudo abrir este artista ahora. Inténtalo de nuevo.",
  artistNotFound: "Artista no encontrado.",
  albumUnavailable: "No se pudo abrir este álbum ahora. Inténtalo de nuevo.",
  albumNotFound: "Álbum no encontrado.",
  invalidAlbum: "Álbum no válido.",
  ytdlpMissing: "No se encontró yt-dlp en este ordenador. Abre Ajustes en Musike para instalarlo.",
  ytdlpTimeout: "yt-dlp tardó demasiado en responder.",
  ytdlpCantRun: "No se pudo ejecutar yt-dlp ({error}). Abre Ajustes en Musike.",
  botCheck: "YouTube pide a esta conexión que demuestre que no es un robot. Si usas una VPN, desactívala e inténtalo de nuevo.",
  videoUnavailable: "Este vídeo no está disponible en YouTube.",
  ageRestricted: "Vídeo con restricción de edad. Necesita cookies de una cuenta con sesión iniciada.",
  ytdlpFailed: "yt-dlp falló.",
  ytdlpOutdated: "{detail} Puede que YouTube haya cambiado: actualiza yt-dlp en Ajustes.",
  noAudio: "No hay ningún formato de audio disponible para este vídeo.",
  noSdVideo: "Este vídeo no tiene versión SD combinada. Usa HD.",
  streamRefused: "YouTube rechazó el stream (HTTP {status}). Prueba a actualizar yt-dlp en Ajustes.",
  noWinget: "No se encontró yt-dlp y winget no está disponible. Instálalo manualmente: https://github.com/yt-dlp/yt-dlp",
  installingYtdlp: "Instalando yt-dlp",
  updatingYtdlp: "Actualizando yt-dlp",
  directUpdateFailed: "La actualización directa falló; probando con winget",
  downloadingTools: "Descargando yt-dlp y Deno desde GitHub",
  alreadyLatest: "Ya está en la última versión ({version})",
  ytdlpReady: "yt-dlp {version} está listo para usar",
  updateFailed: "No se pudo actualizar yt-dlp.",
  toolMissing: "No se encontró {tool} en este ordenador.",
  downloadFailed: "La descarga de {tool} falló (HTTP {status}).",
  ffmpegPackage: "Paquete de FFmpeg inesperado.",
};

const CATALOG: Record<Lang, Record<MsgKey, string>> = { en, fr, es };

/** A message translated when it is sent: a key plus the values for its {placeholders}. */
export interface Msg {
  key: MsgKey;
  params?: Params;
}

/** Something to show a person: a message to translate, or text that needs none (tool output). */
export type Text = Msg | string;

export const msg = (key: MsgKey, params?: Params): Msg => ({ key, params });

export function tr(lang: Lang, text: Text): string {
  if (typeof text === "string") return text;
  return CATALOG[lang][text.key].replace(/\{(\w+)\}/g, (all, name: string) => String(text.params?.[name] ?? all));
}

export const isLang = (v: unknown): v is Lang => v === "en" || v === "fr" || v === "es";

/** The language a request asked for. The app always says; anything else (media elements, curl) gets English. */
export function langOf(req: { headers: Record<string, string | string[] | undefined> }): Lang {
  const asked = req.headers["x-musike-lang"];
  return isLang(asked) ? asked : "en";
}

/** The code YouTube Music uses for its own words (genre names, artist bios). */
export const youtubeLang = (lang: Lang) => lang;
