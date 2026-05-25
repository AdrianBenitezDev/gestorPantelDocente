(function(){
  const slotId = 'stockfacil-banner-slot';
  const modalId = 'stockfacilModal';

  if(document.getElementById(modalId)){
    return;
  }

  const findOrCreateSlot = function(){
    const existingSlot = document.getElementById(slotId);
    if(existingSlot){
      return existingSlot;
    }

    const createdSlot = document.createElement('div');
    createdSlot.id = slotId;

    const sharedFooterRoot = document.getElementById('shared-footer-root');
    if(sharedFooterRoot && sharedFooterRoot.parentNode){
      sharedFooterRoot.parentNode.insertBefore(createdSlot, sharedFooterRoot);
      return createdSlot;
    }

    const footer = document.querySelector('footer');
    if(footer && footer.parentNode){
      footer.parentNode.insertBefore(createdSlot, footer);
      return createdSlot;
    }

    document.body.appendChild(createdSlot);
    return createdSlot;
  };

  const slot = findOrCreateSlot();
  slot.innerHTML = [
    '<div class="stockfacil-modal-overlay" id="stockfacilModal" aria-hidden="false">',
    '  <div class="stockfacil-modal" role="region" aria-label="Publicidad Stock Facil">',
    '    <span class="stockfacil-modal-tag">Publicidad</span>',
    '    <div class="stockfacil-carousel">',
    '      <button type="button" class="stockfacil-nav prev" id="stockfacilPrev" aria-label="Imagen anterior">&#8249;</button>',
    '      <a class="stockfacil-modal-link" href="https://stockfacil.com.ar" target="_blank" rel="noopener noreferrer sponsored" aria-label="Ir a Stock Facil">',
    '        <img id="stockfacilModalImage" class="stockfacil-modal-image" src="" alt="Stock Facil banner 1" loading="lazy">',
    '      </a>',
    '      <button type="button" class="stockfacil-nav next" id="stockfacilNext" aria-label="Imagen siguiente">&#8250;</button>',
    '    </div>',
    '    <div class="stockfacil-indicators">',
    '      <button type="button" class="stockfacil-dot is-active" aria-label="Ir al banner 1"></button>',
    '      <button type="button" class="stockfacil-dot" aria-label="Ir al banner 2"></button>',
    '      <button type="button" class="stockfacil-dot" aria-label="Ir al banner 3"></button>',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('');

  const stockfacilModal = document.getElementById('stockfacilModal');
  const stockfacilImage = document.getElementById('stockfacilModalImage');
  const stockfacilPrev = document.getElementById('stockfacilPrev');
  const stockfacilNext = document.getElementById('stockfacilNext');
  const stockfacilDots = Array.from(document.querySelectorAll('.stockfacil-dot'));

  const scriptTag = document.currentScript;
  const assetsBase = scriptTag && scriptTag.src
    ? new URL('.', scriptTag.src).toString()
    : './publicidad/';

  const stockfacilBanners = [
    new URL('banner_1.png', assetsBase).toString(),
    new URL('banner_2.png', assetsBase).toString(),
    new URL('banner_3.png', assetsBase).toString()
  ];

  if(!(stockfacilModal && stockfacilImage)){
    return;
  }

  let currentStockfacilBanner = 0;
  let stockfacilTimer = null;

  const setStockfacilBanner = function(index){
    currentStockfacilBanner = (index + stockfacilBanners.length) % stockfacilBanners.length;
    stockfacilImage.src = stockfacilBanners[currentStockfacilBanner];
    stockfacilImage.alt = 'Stock Facil banner ' + (currentStockfacilBanner + 1);
    stockfacilDots.forEach(function(dot, dotIndex){
      dot.classList.toggle('is-active', dotIndex === currentStockfacilBanner);
    });
  };

  const stopStockfacilRotation = function(){
    if(stockfacilTimer){
      clearInterval(stockfacilTimer);
      stockfacilTimer = null;
    }
  };

  const startStockfacilRotation = function(){
    stopStockfacilRotation();
    stockfacilTimer = setInterval(function(){
      const nextIndex = (currentStockfacilBanner + 1) % stockfacilBanners.length;
      setStockfacilBanner(nextIndex);
    }, 5000);
  };

  stockfacilModal.setAttribute('aria-hidden', 'false');
  setStockfacilBanner(0);
  startStockfacilRotation();

  const goToNextStockfacil = function(){
    setStockfacilBanner(currentStockfacilBanner + 1);
    startStockfacilRotation();
  };

  const goToPrevStockfacil = function(){
    setStockfacilBanner(currentStockfacilBanner - 1);
    startStockfacilRotation();
  };

  if(stockfacilNext){
    stockfacilNext.addEventListener('click', goToNextStockfacil);
  }

  if(stockfacilPrev){
    stockfacilPrev.addEventListener('click', goToPrevStockfacil);
  }

  stockfacilDots.forEach(function(dot, dotIndex){
    dot.addEventListener('click', function(){
      setStockfacilBanner(dotIndex);
      startStockfacilRotation();
    });
  });

  document.addEventListener('visibilitychange', function(){
    if(document.hidden){
      stopStockfacilRotation();
      return;
    }

    startStockfacilRotation();
  });
})();
