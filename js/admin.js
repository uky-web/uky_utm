(function (Drupal) {
    "use strict";
    Drupal.behaviors.ukyUtmAdmin = {
      attach(context) {
        const input = context.querySelector
          ? context.querySelector('input[data-uky-utm-referrer-preview]')
          : null;
        if (input && !input.dataset.ukyUtmBound) {
          const rawRef = (document.referrer || "").trim();
          input.value = rawRef ? rawRef : "Direct Traffic";
          input.dataset.ukyUtmBound = "1";
        }
      },
    };
  })(Drupal);
  