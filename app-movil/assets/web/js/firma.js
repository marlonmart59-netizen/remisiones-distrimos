/* Panel de firma con el dedo o el mouse (Pointer Events + canvas). */
(function () {
  function PanelFirma(canvas) {
    const ctx = canvas.getContext('2d');
    let dibujando = false;
    let vacio = true;
    let ultimo = null;

    function ajustar() {
      const r = canvas.getBoundingClientRect();
      const escala = window.devicePixelRatio || 1;
      const copia = vacio ? null : canvas.toDataURL();
      canvas.width = Math.max(1, Math.round(r.width * escala));
      canvas.height = Math.max(1, Math.round(r.height * escala));
      ctx.setTransform(escala, 0, 0, escala, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#0b1b2e';
      ctx.lineWidth = 2.6;
      if (copia) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, r.width, r.height); img.src = copia; }
    }

    function pos(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      dibujando = true; ultimo = pos(e);
      ctx.beginPath(); ctx.arc(ultimo.x, ultimo.y, 1.2, 0, Math.PI * 2); ctx.fillStyle = '#0b1b2e'; ctx.fill();
      vacio = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dibujando) return;
      e.preventDefault();
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(ultimo.x, ultimo.y);
      const mx = (ultimo.x + p.x) / 2; const my = (ultimo.y + p.y) / 2;
      ctx.quadraticCurveTo(ultimo.x, ultimo.y, mx, my); ctx.lineTo(p.x, p.y); ctx.stroke();
      ultimo = p;
    });
    const fin = () => { dibujando = false; };
    canvas.addEventListener('pointerup', fin);
    canvas.addEventListener('pointercancel', fin);
    window.addEventListener('resize', ajustar);
    setTimeout(ajustar, 0);

    return {
      limpiar() { ctx.clearRect(0, 0, canvas.width, canvas.height); vacio = true; },
      estaVacia() { return vacio; },
      /** Devuelve PNG con fondo blanco recortado al área firmada. */
      imagen() {
        const tmp = document.createElement('canvas');
        tmp.width = canvas.width; tmp.height = canvas.height;
        const t = tmp.getContext('2d');
        t.fillStyle = '#fff'; t.fillRect(0, 0, tmp.width, tmp.height); t.drawImage(canvas, 0, 0);
        const max = 700;
        if (tmp.width > max) {
          const r = document.createElement('canvas');
          r.width = max; r.height = Math.round(tmp.height * (max / tmp.width));
          r.getContext('2d').drawImage(tmp, 0, 0, r.width, r.height);
          return r.toDataURL('image/png');
        }
        return tmp.toDataURL('image/png');
      },
    };
  }
  window.PanelFirma = PanelFirma;
})();
