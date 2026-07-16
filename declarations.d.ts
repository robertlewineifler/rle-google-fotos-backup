declare module 'piexifjs' {
    const piexif: any;
    export default piexif;
}

declare namespace JSX {
    interface IntrinsicElements {
        webview: any;
        [elemName: string]: any;
    }
}