export function artifactDocument(source: string): string {
  const template = document.createElement("template");
  template.innerHTML = source;
  for (const element of template.content.querySelectorAll("script,meta,link,base,iframe,frame,object,embed,form,foreignObject,animate,set,animateMotion,animateTransform")) element.remove();
  for (const element of template.content.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || ["href", "xlink:href", "action", "formaction", "srcdoc", "target", "ping", "download"].includes(name)
        || ["src", "srcset", "poster"].includes(name) && !/^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><style>body{margin:16px;overflow-wrap:anywhere}img,svg{max-width:100%}</style>${template.innerHTML}`;
}
