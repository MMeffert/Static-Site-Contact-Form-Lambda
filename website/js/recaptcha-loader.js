"use strict";

// Dynamically load reCAPTCHA Enterprise script using site key from meta tag
(function() {
  var metaSiteKey = document.querySelector('meta[name="recaptcha-site-key"]');
  if (!metaSiteKey) return;
  var siteKey = metaSiteKey.getAttribute('content');
  if (!siteKey) return;
  var s = document.createElement('script');
  s.src = 'https://www.google.com/recaptcha/enterprise.js?render=' + encodeURIComponent(siteKey);
  s.async = true;
  s.defer = true;
  document.head.appendChild(s);
})();
