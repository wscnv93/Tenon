declare module "web-tree-sitter" {
  const Parser: {
    init: () => Promise<void>;
    Language: { load: (bytes: Uint8Array) => Promise<any> };
    new (): {
      setLanguage: (language: any) => void;
      parse: (source: string) => any;
    };
  };
  export default Parser;
}
