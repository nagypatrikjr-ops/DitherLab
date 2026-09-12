import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly text: string;
  readonly action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, text: string, action?: ToastAction) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;
const MAX_VISIBLE = 4;

/** Short confirmations and errors in the corner of the window. */
export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (kind, text, action) => {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, kind, text, action }].slice(-MAX_VISIBLE) });
    const ms = kind === 'error' ? 9000 : action ? 7000 : 4000;
    window.setTimeout(() => get().dismiss(id), ms);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export function toast(kind: ToastKind, text: string, action?: ToastAction): void {
  useToasts.getState().push(kind, text, action);
}
