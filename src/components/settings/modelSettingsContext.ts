import { createContext, useContext } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { useSettings, type SettingsStore } from '../../store/settings';

export type ModelSettingsState = SettingsStore;
/** The same editor can use local settings or an unpersisted cloud draft. */
export const ModelSettingsContext = createContext<StoreApi<ModelSettingsState>>(useSettings);
export const useModelSettingsStore = () => useContext(ModelSettingsContext);
const identity = (state: ModelSettingsState) => state;
export function useModelSettings<T = ModelSettingsState>(selector: (state: ModelSettingsState) => T = identity as (state: ModelSettingsState) => T): T {
  return useStore(useModelSettingsStore(), selector);
}
