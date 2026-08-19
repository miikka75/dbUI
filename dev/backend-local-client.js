// backend-local-client.js — Local server backend adapter
backend = {
  getSchema: () => _post('getSchema', {}),
  saveSchema: (schema) => _post('saveSchema', { schema }),
  validateFolder: (id) => _post('validateFolder', { id }),
  getFolderConfig: () => _post('getFolderConfig', {}),
  setFolderConfig: (config) => _post('setFolderConfig', { config }),
  initSchema: (schema) => _post('initSchema', { schema }),
  bootData: () => _post('bootData', {}),
  getAvailableTables: () => _post('getAvailableTables', {}),
  getAvailableLanguages: () => _post('getAvailableLanguages', {}),
  getTableData: (tableId, tab) => _post('getTableData', { tableId, tab }),
  putRow: (tableId, data, tab) => _post('putRow', { tableId, data, tab }),
  deleteRow: (tableId, id, tab) => _post('deleteRow', { tableId, id, tab }),
  getTranslations: (langCode) => _post('getTranslations', { langCode }),
  updateTranslations: (langCode, updates) => _post('updateTranslations', { langCode, updates }),
  createLanguage: (code, name, keys) => _post('createLanguage', { code, name, keys }),
  deleteLanguage: (code) => _post('deleteLanguage', { code }),
  renameLanguage: (code, name) => _post('renameLanguage', { code, name }),
  getLists: () => _post('getLists', {}),
  saveLists: (lists) => _post('saveLists', { lists }),
  putListItem: (listName, value) => _post('putListItem', { listName, value }),
  getListAvatars: () => _post('getListAvatars', {}),                                       // viewer-safe value->picture
  getListUserLinks: () => _post('getListUserLinks', {}),                                   // admin-only value->email
  getMyListValues: () => _post('getMyListValues', {}),                                     // self-scoped list->myValue
  setListUser: (listName, value, email) => _post('setListUser', { listName, value, email }),
  moveRow: (tableId, rowData, fromTab, toTab) => _post('moveRow', { tableId, rowData, fromTab, toTab }),
};
if (typeof _devUploadFile === 'function') backend.uploadFile = _devUploadFile; // image-column upload (dev store)
if (typeof _devSubscribeTable === 'function') backend.subscribeTable = _devSubscribeTable; // live sync (SSE)

init();
