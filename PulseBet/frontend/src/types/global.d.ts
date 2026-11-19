export { };

declare global {
    interface Window {
        /** Removed wallet-extension hook; kept so legacy code cannot break builds. */
        linera?: any;
    }
}
