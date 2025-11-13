import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import https from 'https';

const ses = new SESClient({ region: 'us-east-1' });

interface ContactFormData {
  name: string;
  email: string;
  subject?: string;
  message: string;
  site?: string;
  recaptchaToken: string;
}

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
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Credentials': 'false',
  };

  try {
    if (!event.body) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Missing request body' }),
      };
    }

    const data: ContactFormData = JSON.parse(event.body);
    const { name, email, subject = 'Contact Form Submission', message, site = 'yourdomain.com', recaptchaToken } = data;

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

    if (!recaptchaToken) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Missing reCAPTCHA token' }),
      };
    }

    // Get reCAPTCHA credentials from Secrets Manager
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const secretsClient = new SecretsManagerClient({ region: 'us-east-1' });
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
