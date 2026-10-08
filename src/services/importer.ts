// The importer page (sharedcut.com/importer) and the server share these, so both decide matches the same way.

/** A font family or file name as a match key: lowercase letters and digits. "Futura PT" matches FuturaPT-Bold.otf by prefix. */
export const fontKey = (family: string) => family.toLowerCase().replace(/[^a-z0-9]/g, '');
