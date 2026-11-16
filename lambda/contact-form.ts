import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import https from 'https';

const ses = new SESClient({ region: 'us-east-1' });
const secretsClient = new SecretsManagerClient({ region: 'us-east-1' });
const dynamodb = new DynamoDBClient({ region: 'us-east-1' });

interface ContactFormData {
  name: string;
  email: string;
  subject?: string;
  message: string;
  site?: string;
  recaptchaToken?: string;
  altcha?: string;
}

const getAltchaKey = async (): Promise<string> => {
  if (!process.env.ALTCHA_SECRET_ARN) {
    throw new Error('ALTCHA secret must be configured');
  }
  const secret = await secretsClient.send(new GetSecretValueCommand({
    SecretId: process.env.ALTCHA_SECRET_ARN,
  }));
  const config = JSON.parse(secret.SecretString || '{}');
  if (typeof config.hmacKey !== 'string' || !config.hmacKey.trim()) {
    throw new Error('ALTCHA secret must contain hmacKey');
  }
  return config.hmacKey;
};

// ALTCHA widget 2.x submits the v1 SHA-256/HMAC payload as base64 JSON.
// Verify with the upstream library, then atomically consume it across Lambda instances.
const verifyAltcha = async (encoded: unknown): Promise<boolean> => {
  if (typeof encoded !== 'string' || encoded.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return false;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return false;
  }
  if (!payload || payload.algorithm !== 'SHA-256' || typeof payload.salt !== 'string' ||
      payload.salt.length > 1024 || !Number.isSafeInteger(payload.number) || payload.number < 0 ||
      typeof payload.challenge !== 'string' || !/^[a-f0-9]{64}$/i.test(payload.challenge) ||
      typeof payload.signature !== 'string' || !/^[a-f0-9]{64}$/i.test(payload.signature)) {
    return false;
  }
  const params = new URLSearchParams(payload.salt.split('?')[1] || '');
  const expires = Number(params.get('expires'));
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) {
    return false;
  }

  if (!process.env.ALTCHA_CHALLENGE_TABLE) {
    throw new Error('ALTCHA challenge table must be configured');
  }
  const hmacKey = await getAltchaKey();
  const { verifySolution } = await import('altcha-lib/v1');
  if (!await verifySolution(payload, hmacKey, true)) {
    return false;
  }

  try {
    await dynamodb.send(new PutItemCommand({
      TableName: process.env.ALTCHA_CHALLENGE_TABLE,
      Item: { challenge: { S: payload.challenge }, expires: { N: String(expires) } },
      ConditionExpression: 'attribute_not_exists(challenge)',
    }));
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw error;
  }
  return true;
};

const verifyRecaptcha = (token: string, apiKey: string, projectId: string, siteKey: string, expectedAction: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      event: {
        token: token,
        siteKey: siteKey
      }
    });

    const options = {
      hostname: 'recaptchaenterprise.googleapis.com',
      path: `/v1/projects/${projectId}/assessments?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          if (!body) {
            reject(new Error('Empty response from reCAPTCHA'));
            return;
          }
          const result = JSON.parse(body);
          
          if (!result.tokenProperties?.valid) {
            console.log(`Token invalid: ${result.tokenProperties?.invalidReason}`);
            resolve(false);
            return;
          }
          
          if (result.tokenProperties.action !== expectedAction) {
            console.log(`Action mismatch: expected ${expectedAction}, got ${result.tokenProperties.action}`);
            resolve(false);
            return;
          }
          
          const score = result.riskAnalysis?.score || 0;
          console.log(`reCAPTCHA score: ${score}`);
          resolve(score >= 0.5);
        } catch (e) {
          console.error('reCAPTCHA parsing error:', e);
          reject(e instanceof Error ? e : new Error('Failed to parse reCAPTCHA response'));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const allowedOrigins = ['https://yourdomain.com', 'https://www.yourdomain.com'];
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = {
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Credentials': 'false',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const captchaProvider = process.env.CAPTCHA_PROVIDER || 'recaptcha';
    if (event.httpMethod === 'GET' && event.path === '/contact/challenge' && captchaProvider === 'altcha') {
      const hmacKey = await getAltchaKey();
      const { createChallenge } = await import('altcha-lib/v1');
      const challenge = await createChallenge({
        algorithm: 'SHA-256', hmacKey, maxNumber: 100000,
        expires: new Date(Date.now() + 5 * 60 * 1000),
      });
      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(challenge),
      };
    }
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: { ...headers, Allow: 'POST,OPTIONS' }, body: '' };
    }
    if (!event.body) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Missing request body' }),
      };
    }

    const data: ContactFormData = JSON.parse(event.body);
    const { name, email, subject = 'Contact Form Submission', message, site = 'yourdomain.com', recaptchaToken, altcha } = data;

    // Input validation
    if (!name || name.length < 2 || name.length > 100) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Invalid name' }),
      };
    }

    if (!email || !/^[\w-\.]+@([\w-]+\.)+[\w-]{2,6}$/.test(email)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Invalid email' }),
      };
    }

    if (!message || message.length < 1 || message.length > 5000) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Invalid message' }),
      };
    }

    if (typeof subject !== 'string' || subject.length > 200 || /[\u0000-\u001f\u007f]/.test(subject)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Invalid subject' }),
      };
    }

    if (captchaProvider === 'altcha') {
      if (!await verifyAltcha(altcha)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ message: 'ALTCHA verification failed' }),
        };
      }
    } else if (captchaProvider === 'recaptcha') {
      if (!recaptchaToken) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ message: 'Missing reCAPTCHA token' }),
        };
      }

      // Get reCAPTCHA credentials from Secrets Manager
      const secretResponse = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: process.env.RECAPTCHA_SECRET_ARN })
      );
      const recaptchaConfig = JSON.parse(secretResponse.SecretString!);

      const isValidRecaptcha = await verifyRecaptcha(
        recaptchaToken,
        recaptchaConfig.apiKey,
        recaptchaConfig.projectId,
        recaptchaConfig.siteKey,
        'submit'
      );
      if (!isValidRecaptcha) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ message: 'reCAPTCHA verification failed' }),
        };
      }
    } else {
      throw new Error('Unsupported CAPTCHA_PROVIDER');
    }

    const sanitize = (str: string): string => {
      return str.replace(/[<>"'&]/g, (char) => {
        const entities: { [key: string]: string } = {
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#x27;',
          '&': '&amp;'
        };
        return entities[char] || char;
      });
    };

    const emailBody = `
New contact form submission from ${sanitize(site)}

Name: ${sanitize(name)}
Email: ${sanitize(email)}
Subject: ${sanitize(subject)}

Message:
${sanitize(message)}

Submitted: ${new Date().toISOString()}
`;

    const command = new SendEmailCommand({
      Source: process.env.FROM_EMAIL!,
      Destination: {
        ToAddresses: [process.env.TO_EMAIL!],
      },
      Message: {
        Subject: {
          Data: `Contact Form: ${subject}`,
          Charset: 'UTF-8',
        },
        Body: {
          Text: {
            Data: emailBody,
            Charset: 'UTF-8',
          },
        },
      },
      ReplyToAddresses: [email],
    });

    await ses.send(command);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: 'Email sent successfully' }),
    };
  } catch (error) {
    console.error('Error processing contact form:', error instanceof Error ? error.message : 'Unknown error');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'Failed to send email' }),
    };
  }
};
