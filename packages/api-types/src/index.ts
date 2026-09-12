// The part of Formfeed's internal @formfeed/api-types that the published packages use: the
// apitemplate.io settings mapping, shared by the API's compatibility layer and the engine's importer,
// and the file library's name rules, shared by the API and the dev kit's files folder. It is inlined
// into the packages at build time and not published on its own.
export * from './lib/apitemplate';
export * from './lib/assets';
