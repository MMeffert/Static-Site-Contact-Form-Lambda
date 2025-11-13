"use strict";

function submitToAPI(e) {
  e.preventDefault();

  var Namere = /[A-Za-z]{2,}/;
  if (!Namere.test($("#name").val())) {
    alert("Name must be at least 2 characters");
    return;
  }
  if ($("#mail").val() == "") {
    alert("Please enter your email address");
    return;
  }

  var reeamil = /^([\w-\.]+@([\w-]+\.)+[\w-]{2,6})$/;
  if (!reeamil.test($("#mail").val())) {
    alert("Please enter a valid email address");
    return;
  }

  var metaApi = document.querySelector('meta[name="contact-api"]');
  var metaSiteKey = document.querySelector('meta[name="recaptcha-site-key"]');
  var URL = metaApi ? metaApi.getAttribute('content') : "YOUR_API_GATEWAY_URL";
  var siteKey = metaSiteKey ? metaSiteKey.getAttribute('content') : 'YOUR_RECAPTCHA_SITE_KEY';

  var $btn = $("#contact-submit");
  var originalBtnHtml = $btn.html();
  function setSending(sending) {
    if (sending) {
      $btn.prop('disabled', true).attr('aria-busy', 'true').text('Sending…');
    } else {
      $btn.prop('disabled', false).removeAttr('aria-busy').html(originalBtnHtml);
    }
  }

  if (window.grecaptcha && grecaptcha.enterprise && grecaptcha.enterprise.execute) {
    grecaptcha.enterprise.ready(function() {
      grecaptcha.enterprise.execute(siteKey, {action: 'submit'}).then(function(token) {
        submitWithToken(token);
      }).catch(function(err){
        console.error('reCAPTCHA execute error', err);
        submitWithToken(null);
      });
    });
  } else {
    submitWithToken(null);
  }

  function submitWithToken(token) {
    var name = $("#name").val();
    var email = $("#mail").val();
    var subject = $("#subject").val();
    var message = $("#comment").val();
    var data = {
      site: 'yourdomain.com',
      name: name,
      email: email,
      subject: subject,
      message: message,
      recaptchaToken: token
    };

    setSending(true);

    $.ajax({
      type: "POST",
      url: URL,
      dataType: "json",
      crossDomain: "true",
      contentType: "application/json; charset=utf-8",
      data: JSON.stringify(data),
      success: function (resp) {
        var msg = 'Message sent successfully.';
        if (resp && resp.message) msg = resp.message;
        $("#message").css('color', 'green').text(msg).attr('tabindex', '-1').focus();
        document.getElementById('name').value = '';
        document.getElementById('mail').value = '';
        document.getElementById('subject').value = '';
        document.getElementById('comment').value = '';
        setSending(false);
      },
      error: function (xhr, status, err) {
        var errMsg = 'Error. Your message was not sent.';
        try {
          var j = JSON.parse(xhr.responseText);
          if (j && j.message) errMsg = j.message;
        } catch (e) {
          // ignore
        }
        $("#message").css('color', 'red').text(errMsg).attr('tabindex', '-1').focus();
        setSending(false);
      }
    });
  }
}
