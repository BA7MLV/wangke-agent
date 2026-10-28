import { configureModelMetaStorage } from '@wangke/study-core/model/meta';

// Browser persistence belongs to the Web adapter, never the shared runtime.
configureModelMetaStorage({
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});
export * from '@wangke/study-core/model/meta';
