/**
 * SAML SSO (brief §14.1). Completes the SSO surface alongside OIDC: this serves
 * the Service-Provider (SP) metadata that an IdP needs to register RIOS, and
 * lists the SAML providers configured via the existing identity_provider store
 * (POST /api/auth/sso/providers with type:'saml'). The assertion-consumer
 * handshake (XML signature validation) is provider-wired - a real deployment
 * plugs in a SAML library at the ACS endpoint (docs/open-questions.md).
 */

import type { FastifyInstance } from 'fastify';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

function spMetadata(baseUrl: string): string {
  const entityId = `${baseUrl}/saml/metadata`;
  const acs = `${baseUrl}/api/auth/saml/acs`;
  return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"
                   protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService index="0" isDefault="true"
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acs}"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
}

export async function samlModule(app: FastifyInstance): Promise<void> {
  // SP metadata for IdP registration (public - an IdP must fetch it).
  app.get('/api/auth/saml/metadata', async (req, reply) => {
    const base = `${req.protocol}://${req.headers.host ?? 'localhost:4000'}`;
    reply.header('content-type', 'application/xml');
    return spMetadata(base);
  });

  // List configured SAML providers (admin).
  app.get('/api/auth/saml/providers', { preHandler: requirePermission('admin:manage') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, key, name, type, issuer, enabled from identity_provider
          where type = 'saml' order by name`,
      );
      return { providers: rows };
    });
  });
}
