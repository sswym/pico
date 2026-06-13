// Bun supports `import x from "./file.md" with { type: "text" }`.
// Provide a global declaration so tsc accepts the import.
declare module "*.md" {
  const content: string;
  export default content;
}
