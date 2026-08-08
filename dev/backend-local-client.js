// backend-local-client.js — Local server backend adapter
backend = {
  getSchema: (folderId) => _post('getSchema', { folderId }),
  saveSchema: (folderId, schema) => _post('saveSchema', { folderId, schema }),
  validateFolder: (id) => _post('validateFolder', { id }),
  getFolderConfig: (folderId) => _post('getFolderConfig', { folderId }),
  setFolderConfig: (folderId, config) => _post('setFolderConfig', { folderId, config }),
  initSchema: (folderId, schema) => _post('initSchema', { folderId, schema }),
  bootData: (folderId) => _post('bootData', { folderId }),
  getAvailableTables: (folderId) => _post('getAvailableTables', { folderId }),
  getAvailableLanguages: (folderId) => _post('getAvailableLanguages', { folderId }),
  getTableData: (tableId, tab) => _post('getTableData', { tableId, tab }),
  putRow: (tableId, data, tab) => _post('putRow', { tableId, data, tab }),
  deleteRow: (tableId, id, tab) => _post('deleteRow', { tableId, id, tab }),
  getTranslations: (folderId, langCode) => _post('getTranslations', { folderId, langCode }),
  updateTranslations: (folderId, langCode, updates) => _post('updateTranslations', { folderId, langCode, updates }),
  createLanguage: (folderId, code, name, keys) => _post('createLanguage', { folderId, code, name, keys }),
  deleteLanguage: (folderId, code) => _post('deleteLanguage', { folderId, code }),
  renameLanguage: (folderId, code, name) => _post('renameLanguage', { folderId, code, name }),
  getFileModifiedTime: (fileId) => _post('getFileModifiedTime', { fileId }).then(r => r.time),
  getLists: (folderId) => _post('getLists', { folderId }),
  saveLists: (folderId, lists) => _post('saveLists', { folderId, lists }),
  putListItem: (folderId, listName, value) => _post('putListItem', { folderId, listName, value }),
  getListAvatars: () => _post('getListAvatars', {}),                                       // viewer-safe value->picture
  getListUserLinks: () => _post('getListUserLinks', {}),                                   // admin-only value->email
  getMyListValues: () => _post('getMyListValues', {}),                                     // self-scoped list->myValue
  setListUser: (listName, value, email) => _post('setListUser', { listName, value, email }),
  moveRow: (tableId, rowData, fromTab, toTab) => _post('moveRow', { tableId, rowData, fromTab, toTab }),
  saveChangesets: (folderId, siteId, json) => _post('saveChangesets', { folderId, siteId, json }),
  loadChangesets: (folderId, excludeSiteId) => _post('loadChangesets', { folderId, excludeSiteId })
};
if (typeof _devUploadFile === 'function') backend.uploadFile = _devUploadFile; // image-column upload (dev store)

init();
