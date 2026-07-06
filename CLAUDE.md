# Static Site Contact Form Lambda

Serverless contact form solution for static websites.

## Overview

- **Type**: AWS Lambda Function + Static Frontend
- **Backend**: TypeScript/Node.js
- **Frontend**: Vanilla JavaScript + jQuery
- **Purpose**: Production-ready contact form handling

## Features

### Backend (Lambda)
- Input validation (name, email, message length)
- Email sanitization (injection prevention)
- Google reCAPTCHA Enterprise integration
- AWS SES for email delivery
- AWS Secrets Manager for credentials
- CORS protection with origin validation
- Comprehensive error handling

### Frontend
- JavaScript form handler
- reCAPTCHA loader
- Accessible HTML form with ARIA attributes

## Architecture

```
Client Form → API Gateway (POST /contact) → Lambda → SES Email
                                              ↓
                                    reCAPTCHA Verification
```

## Project Structure

```
├── lambda/
│   ├── contact-form.ts    # Lambda handler
│   └── package.json
├── website/
│   ├── js/               # Client-side scripts
│   └── contact-form-example.html   # Example form
└── README.md
```

## Cost

~$0.41/month for 100 submissions (AWS free tier coverage)
