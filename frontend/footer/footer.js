(function () {
  const ROOT_ID = "shared-footer-root";
  const STYLE_ID = "shared-footer-style-link";

  const currentScript = document.currentScript;
  const scriptBase = currentScript
    ? new URL("./", currentScript.src).toString()
    : "/footer/";
  const styleHref = new URL("footer.css", scriptBase).toString();

  if (!document.getElementById(STYLE_ID)) {
    const link = document.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = styleHref;
    document.head.appendChild(link);
  }

  const render = () => {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      document.body.appendChild(root);
    }

    const year = new Date().getFullYear();
    root.innerHTML = `
      <footer class="shared-footer" aria-label="Pie de pagina">
        <div class="shared-footer-inner">
          <section class="shared-footer-block">
            <h3>PanelDocente</h3>
            <p>
              Plataforma para gestion escolar, horarios y flujos PAC.
            </p>
          </section>
          <section class="shared-footer-block">
            <h3>Navegacion</h3>
            <ul class="shared-footer-links">
              <li><a href="/index.html">Inicio</a></li>
              <li><a href="/registro.html">Registro</a></li>
              <li><a href="/pac.html">Crear PAC</a></li>
            </ul>
          </section>
          <section class="shared-footer-block">
            <h3>Legal y Contacto</h3>
            <ul class="shared-footer-links">
              <li><a href="/politica-privacidad.html">Politica de privacidad</a></li>
              <li><a href="mailto:artbenitezdev@gmail.com">artbenitezdev@gmail.com</a></li>
            </ul>
          </section>
        </div>
        <div class="shared-footer-bottom">
          &copy; ${year} PanelDocente. Todos los derechos reservados.
        </div>
      </footer>
    `;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render, { once: true });
  } else {
    render();
  }
})();
