import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/unstable/httpapi";

import * as Schemas from "./Schemas.ts";

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "emailer/Api/Authorization",
  {
    requiredForClient: true,
    security: { bearer: HttpApiSecurity.bearer },
    error: Unauthorized,
  },
) {}

const listingQuery = {
  cursor: Schema.optional(Schemas.EntityCursor),
  limit: Schema.optional(Schemas.PageSize),
};

/** Member listings page by member sort key, which is the contact's identifier. */
const memberQuery = {
  cursor: Schema.optional(Schemas.EntityId),
  limit: Schema.optional(Schemas.PageSize),
};

/** Every endpoint can refuse a malformed request and find storage unavailable. */
const standardErrors = [HttpApiError.BadRequestNoContent, Schemas.StorageUnavailable] as const;

/** Every endpoint that names an entity can also find it missing. */
const lookupErrors = [...standardErrors, Schemas.NotFound] as const;

class ContactsGroup extends HttpApiGroup.make("contacts")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schemas.CreateContactPayload,
      success: Schemas.Contact.pipe(HttpApiSchema.status(201)),
      error: [...standardErrors, Schemas.EmailAlreadyUsed, Schemas.PayloadTooLarge],
    }),
    HttpApiEndpoint.get("list", "/", {
      query: listingQuery,
      success: Schemas.page(Schemas.Contact, Schemas.EntityCursor),
      error: standardErrors,
    }),
    // A static segment wins over ":id" in the router regardless of declaration order.
    HttpApiEndpoint.get("getByEmail", "/by-email", {
      query: { email: Schemas.EmailAddress },
      success: Schemas.Contact,
      error: lookupErrors,
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schemas.EntityId },
      success: Schemas.Contact,
      error: lookupErrors,
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: Schemas.EntityId },
      payload: Schemas.UpdateContactPayload,
      success: Schemas.Contact,
      error: [
        ...lookupErrors,
        Schemas.EmailAlreadyUsed,
        Schemas.AddressOptedOut,
        Schemas.PayloadTooLarge,
      ],
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: lookupErrors,
    }),
  )
  .prefix("/contacts") {}

class ListsGroup extends HttpApiGroup.make("lists")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schemas.CreateListPayload,
      success: Schemas.ContactList.pipe(HttpApiSchema.status(201)),
      error: [...standardErrors, Schemas.PayloadTooLarge],
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schemas.EntityId },
      success: Schemas.ContactList,
      error: lookupErrors,
    }),
    HttpApiEndpoint.get("list", "/", {
      query: listingQuery,
      success: Schemas.page(Schemas.ContactList, Schemas.EntityCursor),
      error: standardErrors,
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: Schemas.EntityId },
      payload: Schemas.UpdateListPayload,
      success: Schemas.ContactList,
      error: [...lookupErrors, Schemas.PayloadTooLarge],
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: lookupErrors,
    }),
    HttpApiEndpoint.get("listMembers", "/:listId/members", {
      params: { listId: Schemas.EntityId },
      query: memberQuery,
      success: Schemas.page(Schemas.Contact, Schemas.EntityId),
      error: lookupErrors,
    }),
    HttpApiEndpoint.put("addContact", "/:listId/members/:contactId", {
      params: { listId: Schemas.EntityId, contactId: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: lookupErrors,
    }),
    HttpApiEndpoint.delete("removeContact", "/:listId/members/:contactId", {
      params: { listId: Schemas.EntityId, contactId: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: lookupErrors,
    }),
    HttpApiEndpoint.post("import", "/:listId/contacts", {
      params: { listId: Schemas.EntityId },
      payload: Schemas.ImportContactsPayload,
      success: Schemas.ImportContactsResult,
      error: [...lookupErrors, Schemas.PayloadTooLarge],
    }),
  )
  .prefix("/lists") {}

class CampaignsGroup extends HttpApiGroup.make("campaigns")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schemas.CreateCampaignPayload,
      success: Schemas.Campaign.pipe(HttpApiSchema.status(201)),
      error: [...lookupErrors, Schemas.PayloadTooLarge],
    }),
    HttpApiEndpoint.get("list", "/", {
      query: listingQuery,
      success: Schemas.page(Schemas.CampaignSummary, Schemas.EntityCursor),
      error: standardErrors,
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: lookupErrors,
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: Schemas.EntityId },
      payload: Schemas.UpdateCampaignPayload,
      success: Schemas.Campaign,
      error: [...lookupErrors, Schemas.CampaignStateConflict, Schemas.PayloadTooLarge],
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [...lookupErrors, Schemas.CampaignStateConflict],
    }),
    HttpApiEndpoint.post("preview", "/:id/preview", {
      params: { id: Schemas.EntityId },
      success: Schemas.PreviewLink,
      error: lookupErrors,
    }),
    HttpApiEndpoint.post("test", "/:id/test", {
      params: { id: Schemas.EntityId },
      payload: Schemas.TestSendPayload,
      success: Schemas.TestSendResult,
      error: [
        ...lookupErrors,
        Schemas.TestAudienceTooLarge,
        Schemas.SendingPaused,
        Schemas.PayloadTooLarge,
      ],
    }),
    HttpApiEndpoint.post("send", "/:id/send", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: lookupErrors,
    }),
    HttpApiEndpoint.post("resume", "/:id/resume", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: lookupErrors,
    }),
    HttpApiEndpoint.post("schedule", "/:id/schedule", {
      params: { id: Schemas.EntityId },
      payload: Schemas.ScheduleCampaignPayload,
      success: Schemas.Campaign,
      error: [...lookupErrors, Schemas.SendAtNotInFuture],
    }),
    HttpApiEndpoint.post("cancel", "/:id/cancel", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: [...lookupErrors, Schemas.CampaignStateConflict],
    }),
  )
  .prefix("/campaigns") {}

class AddressesGroup extends HttpApiGroup.make("addresses")
  .add(
    HttpApiEndpoint.get("status", "/status", {
      query: { email: Schemas.ListedEmailAddress },
      success: Schemas.AddressRecord,
      error: standardErrors,
    }),
    HttpApiEndpoint.post("unsuppress", "/unsuppress", {
      payload: Schema.Struct({ email: Schemas.ListedEmailAddress }),
      success: Schemas.AddressRecord,
      error: standardErrors,
    }),
  )
  .prefix("/addresses") {}

export class EmailerApi extends HttpApi.make("emailer")
  .add(ContactsGroup)
  .add(ListsGroup)
  .add(CampaignsGroup)
  .add(AddressesGroup)
  .middleware(Authorization) {}
