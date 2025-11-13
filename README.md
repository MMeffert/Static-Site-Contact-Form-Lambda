# Static Site Contact Form Lambda

AWS Lambda code for sending contact form emails from a static website. This solution uses AWS Lambda, API Gateway, SES, and Google reCAPTCHA Enterprise to provide a secure, serverless contact form for static websites.

## Overview

This repository contains everything you need to add a working contact form to your static website:

- **Lambda Function**: Processes form submissions, validates input, verifies reCAPTCHA, and sends emails via SES (see `lambda/contact-form.ts`)
- **Frontend Code**: JavaScript for form submission and reCAPTCHA integration
- **Security**: Input validation, CORS protection, reCAPTCHA Enterprise bot protection
- **Email**: AWS SES for reliable email delivery

**Note**: The `index.js` file in the root is old example code. Use `lambda/contact-form.ts` for the production-ready implementation with reCAPTCHA Enterprise and enhanced security.

## Prerequisites

- AWS Account
- Domain name (for SES email verification)
- Google Cloud account (for reCAPTCHA Enterprise)
- Node.js and npm installed locally
- AWS CLI configured

## Instructions for reCAPTCHA Setup

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the reCAPTCHA Enterprise API

### 2. Create a reCAPTCHA Site Key

1. Navigate to **Security** > **reCAPTCHA Enterprise**
2. Click **Create Key**
3. Configure:
   - **Display name**: Your website name
   - **Platform type**: Website
   - **Domains**: Add your domain (e.g., `yourdomain.com`)
   - **reCAPTCHA type**: Score-based (recommended)
4. Save the **Site Key** - you'll need this for your website

### 3. Create an API Key

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **API Key**
3. Restrict the API key to reCAPTCHA Enterprise API only
4. Save the **API Key** - you'll need this for AWS Secrets Manager

### 4. Get Your Project ID

1. In Google Cloud Console, note your **Project ID** (shown at the top)
2. You'll need this for AWS Secrets Manager

## Instructions for SES Setup

### 1. Verify Your Email Address

```bash
aws ses verify-email-identity --email-address info@yourdomain.com --region us-east-1
```

Check your email and click the verification link.

### 2. Request Production Access (Optional)

By default, SES is in sandbox mode and can only send to verified addresses. For production:

1. Go to AWS SES Console
2. Click **Account Dashboard**
3. Click **Request production access**
4. Fill out the form explaining your use case

### 3. Verify Your Domain (Recommended)

For better deliverability:

1. Go to SES Console > **Verified identities**
2. Click **Create identity** > **Domain**
3. Enter your domain name
4. Add the provided DNS records to your domain

## Instructions for Lambda Setup

### 1. Install Dependencies

```bash
cd lambda
npm install
```

### 2. Compile TypeScript

```bash
npx tsc
```

### 3. Create AWS Secrets Manager Secret

Store your reCAPTCHA credentials securely:

```bash
aws secretsmanager create-secret \
  --name your-site/recaptcha \
  --description "reCAPTCHA Enterprise credentials" \
  --secret-string '{"apiKey":"YOUR_API_KEY","projectId":"YOUR_PROJECT_ID","siteKey":"YOUR_SITE_KEY"}' \
  --region us-east-1
```

Note the ARN returned - you'll need it for the Lambda environment variable.

### 4. Create IAM Role for Lambda

Create a file `trust-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Create the role:

```bash
aws iam create-role \
  --role-name ContactFormLambdaRole \
  --assume-role-policy-document file://trust-policy.json
```

Attach policies:

```bash
# Basic Lambda execution
aws iam attach-role-policy \
  --role-name ContactFormLambdaRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# SES send email
aws iam put-role-policy \
  --role-name ContactFormLambdaRole \
  --policy-name SESSendEmail \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["ses:SendEmail", "ses:SendRawEmail"],
        "Resource": "*"
      }
    ]
  }'

# Secrets Manager read
aws iam put-role-policy \
  --role-name ContactFormLambdaRole \
  --policy-name SecretsManagerRead \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "secretsmanager:GetSecretValue",
        "Resource": "arn:aws:secretsmanager:us-east-1:YOUR_ACCOUNT_ID:secret:your-site/recaptcha-*"
      }
    ]
  }'
```

### 5. Create Lambda Function

```bash
cd lambda
zip -r function.zip contact-form.js package.json node_modules/

aws lambda create-function \
  --function-name ContactFormFunction \
  --runtime nodejs22.x \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/ContactFormLambdaRole \
  --handler contact-form.handler \
  --zip-file fileb://function.zip \
  --timeout 10 \
  --environment Variables="{FROM_EMAIL=info@yourdomain.com,TO_EMAIL=info@yourdomain.com,RECAPTCHA_SECRET_ARN=arn:aws:secretsmanager:us-east-1:YOUR_ACCOUNT_ID:secret:your-site/recaptcha-XXXXXX}" \
  --region us-east-1
```

## Instructions for API Gateway Setup

### 1. Create REST API

```bash
API_ID=$(aws apigateway create-rest-api \
  --name "Contact Form API" \
  --description "API for contact form submissions" \
  --region us-east-1 \
  --query 'id' \
  --output text)

echo "API ID: $API_ID"
```

### 2. Get Root Resource ID

```bash
ROOT_ID=$(aws apigateway get-resources \
  --rest-api-id $API_ID \
  --region us-east-1 \
  --query 'items[0].id' \
  --output text)
```

### 3. Create /contact Resource

```bash
RESOURCE_ID=$(aws apigateway create-resource \
  --rest-api-id $API_ID \
  --parent-id $ROOT_ID \
  --path-part contact \
  --region us-east-1 \
  --query 'id' \
  --output text)
```

### 4. Create POST Method

```bash
aws apigateway put-method \
  --rest-api-id $API_ID \
  --resource-id $RESOURCE_ID \
  --http-method POST \
  --authorization-type NONE \
  --region us-east-1
```

### 5. Integrate with Lambda

```bash
LAMBDA_ARN="arn:aws:lambda:us-east-1:YOUR_ACCOUNT_ID:function:ContactFormFunction"

aws apigateway put-integration \
  --rest-api-id $API_ID \
  --resource-id $RESOURCE_ID \
  --http-method POST \
  --type AWS_PROXY \
  --integration-http-method POST \
  --uri "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/$LAMBDA_ARN/invocations" \
  --region us-east-1
```

### 6. Grant API Gateway Permission to Invoke Lambda

```bash
aws lambda add-permission \
  --function-name ContactFormFunction \
  --statement-id apigateway-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:us-east-1:YOUR_ACCOUNT_ID:$API_ID/*/*" \
  --region us-east-1
```

### 7. Enable CORS

```bash
aws apigateway put-method \
  --rest-api-id $API_ID \
  --resource-id $RESOURCE_ID \
  --http-method OPTIONS \
  --authorization-type NONE \
  --region us-east-1

aws apigateway put-integration \
  --rest-api-id $API_ID \
  --resource-id $RESOURCE_ID \
  --http-method OPTIONS \
  --type MOCK \
  --request-templates '{"application/json":"{\"statusCode\": 200}"}' \
  --region us-east-1

aws apigateway put-method-response \
  --rest-api-id $API_ID \
  --resource-id $RESOURCE_ID \
  --http-method OPTIONS \
  --status-code 200 \
  --response-parameters '{"method.response.header.Access-Control-Allow-Headers":false,"method.response.header.Access-Control-Allow-Methods":false,"method.response.header.Access-Control-Allow-Origin":false}' \
  --region us-east-1

aws apigateway put-integration-response \
  --rest-api-id $API_ID \
  --resource-id $RESOURCE_ID \
  --http-method OPTIONS \
  --status-code 200 \
  --response-parameters '{"method.response.header.Access-Control-Allow-Headers":"'\''Content-Type,X-Amz-Date,Authorization,X-Api-Key'\''',"method.response.header.Access-Control-Allow-Methods":"'\''POST,OPTIONS'\''',"method.response.header.Access-Control-Allow-Origin":"'\''https://yourdomain.com'\'''"}' \
  --region us-east-1
```

### 8. Deploy API

```bash
aws apigateway create-deployment \
  --rest-api-id $API_ID \
  --stage-name prod \
  --region us-east-1

echo "API URL: https://$API_ID.execute-api.us-east-1.amazonaws.com/prod/contact"
```

## Instructions for Website Setup

### 1. Update Lambda Function

Edit `lambda/contact-form.ts` and update:

```typescript
const allowedOrigins = ['https://yourdomain.com', 'https://www.yourdomain.com'];
```

### 2. Add Meta Tags to Your HTML

In your HTML `<head>` section:

```html
<!-- Configure your API endpoint and reCAPTCHA site key -->
<meta name="contact-api" content="https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod/contact">
<meta name="recaptcha-site-key" content="YOUR_RECAPTCHA_SITE_KEY">

<!-- Load reCAPTCHA -->
<script src="js/recaptcha-loader.js"></script>
```

### 3. Add the Contact Form HTML

```html
<form id="contact-form" method="post" role="form" aria-describedby="message">
    <p id="message" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
    
    <div>
        <label for="name">Name *</label>
        <input type="text" id="name" name="name" required aria-required="true">
    </div>
    
    <div>
        <label for="mail">Email *</label>
        <input type="email" id="mail" name="mail" required aria-required="true">
    </div>
    
    <div>
        <label for="subject">Subject</label>
        <input type="text" id="subject" name="subject">
    </div>
    
    <div>
        <label for="comment">Message *</label>
        <textarea id="comment" name="comment" rows="5" required aria-required="true"></textarea>
    </div>
    
    <button type="button" id="contact-submit" aria-label="Send message">
        Send Message
    </button>
</form>
```

### 4. Include JavaScript Files

Before closing `</body>` tag:

```html
<!-- jQuery (required) -->
<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
<script src="js/contact-form.js"></script>
```

### 5. Update contact-form.js

Edit `website/js/contact-form.js` and update the `site` field:

```javascript
var data = {
  site: 'yourdomain.com',  // Update this
  name: name,
  email: email,
  subject: subject,
  message: message,
  recaptchaToken: token
};
```

## Testing

### Test the Lambda Function Directly

```bash
aws lambda invoke \
  --function-name ContactFormFunction \
  --payload '{"body":"{\"name\":\"Test User\",\"email\":\"test@example.com\",\"subject\":\"Test\",\"message\":\"Test message\",\"recaptchaToken\":\"test\"}"}' \
  --region us-east-1 \
  response.json

cat response.json
```

### Test via API Gateway

```bash
curl -X POST https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod/contact \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "subject": "Test Subject",
    "message": "This is a test message",
    "recaptchaToken": "test_token"
  }'
```

## Security Features

- **Input Validation**: Name, email, and message length validation
- **Email Sanitization**: HTML entity encoding to prevent injection
- **CORS Protection**: Only allows requests from specified domains
- **reCAPTCHA Enterprise**: Bot protection with score-based verification
- **Rate Limiting**: Can be configured in API Gateway
- **Secrets Management**: reCAPTCHA credentials stored in AWS Secrets Manager

## Troubleshooting

### Email Not Sending

1. Check SES email verification status
2. Verify Lambda has SES permissions
3. Check CloudWatch Logs for errors

### CORS Errors

1. Verify allowed origins in Lambda function
2. Check API Gateway CORS configuration
3. Ensure OPTIONS method is configured

### reCAPTCHA Failing

1. Verify site key matches your domain
2. Check API key has correct permissions
3. Review CloudWatch Logs for reCAPTCHA errors

### Lambda Timeout

1. Increase timeout in Lambda configuration
2. Check network connectivity to Google reCAPTCHA API

## Cost Estimate

For a typical small website (100 submissions/month):

- **Lambda**: Free tier covers 1M requests/month
- **API Gateway**: Free tier covers 1M requests/month
- **SES**: $0.10 per 1,000 emails = $0.01/month
- **Secrets Manager**: $0.40/month per secret

**Total**: ~$0.41/month

## License

MIT License - Feel free to use this for your own projects!

## Credits

Based on the contact form implementation used by [Roundhouse Partners Inc.](https://roundhousepartnersinc.com)
