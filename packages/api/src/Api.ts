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

const memberQuery = {
  cursor: Schema.optional(Schemas.MemberCursor),
  limit: Schema.optional(Schemas.PageSize),
};

export class ContactsGroup extends HttpApiGroup.make("contacts")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schemas.CreateContactPayload,
      success: Schemas.Contact.pipe(HttpApiSchema.status(201)),
      error: [
        HttpApiError.BadRequestNoContent,
        Schemas.EmailAlreadyUsed,
        Schemas.PayloadTooLarge,
        Schemas.StorageUnavailable,
      ],
    }),
    HttpApiEndpoint.get("list", "/", {
      query: listingQuery,
      success: Schemas.page(Schemas.Contact, Schemas.EntityCursor),
      error: [HttpApiError.BadRequestNoContent, Schemas.StorageUnavailable],
    }),
    // A static segment wins over ":id" in the router regardless of declaration order.
    HttpApiEndpoint.get("getByEmail", "/by-email", {
      query: { email: Schemas.EmailAddress },
      success: Schemas.Contact,
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schemas.EntityId },
      success: Schemas.Contact,
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: Schemas.EntityId },
      payload: Schemas.UpdateContactPayload,
      success: Schemas.Contact,
      error: [
        HttpApiError.BadRequestNoContent,
        Schemas.NotFound,
        Schemas.EmailAlreadyUsed,
        Schemas.AddressOptedOut,
        Schemas.PayloadTooLarge,
        Schemas.StorageUnavailable,
      ],
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
  )
  .middleware(Authorization)
  .prefix("/contacts") {}

export class ListsGroup extends HttpApiGroup.make("lists")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schemas.CreateListPayload,
      success: Schemas.ContactList.pipe(HttpApiSchema.status(201)),
      error: [
        HttpApiError.BadRequestNoContent,
        Schemas.PayloadTooLarge,
        Schemas.StorageUnavailable,
      ],
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schemas.EntityId },
      success: Schemas.ContactList,
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.get("list", "/", {
      query: listingQuery,
      success: Schemas.page(Schemas.ContactList, Schemas.EntityCursor),
      error: [HttpApiError.BadRequestNoContent, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: Schemas.EntityId },
      payload: Schemas.UpdateListPayload,
      success: Schemas.ContactList,
      error: [
        HttpApiError.BadRequestNoContent,
        Schemas.NotFound,
        Schemas.PayloadTooLarge,
        Schemas.StorageUnavailable,
      ],
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.get("listMembers", "/:listId/members", {
      params: { listId: Schemas.EntityId },
      query: memberQuery,
      success: Schemas.page(Schemas.Contact, Schemas.MemberCursor),
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.put("addContact", "/:listId/members/:contactId", {
      params: { listId: Schemas.EntityId, contactId: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.delete("removeContact", "/:listId/members/:contactId", {
      params: { listId: Schemas.EntityId, contactId: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.post("import", "/:listId/contacts", {
      params: { listId: Schemas.EntityId },
      payload: Schemas.ImportContactsPayload,
      success: Schemas.ImportContactsResult,
      error: [
        HttpApiError.BadRequestNoContent,
        Schemas.NotFound,
        Schemas.PayloadTooLarge,
        Schemas.StorageUnavailable,
      ],
    }),
  )
  .middleware(Authorization)
  .prefix("/lists") {}

export class CampaignsGroup extends HttpApiGroup.make("campaigns")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schemas.CreateCampaignPayload,
      success: Schemas.Campaign.pipe(HttpApiSchema.status(201)),
      error: [
        HttpApiError.BadRequestNoContent,
        Schemas.NotFound,
        Schemas.PayloadTooLarge,
        Schemas.StorageUnavailable,
      ],
    }),
    HttpApiEndpoint.get("list", "/", {
      query: listingQuery,
      success: Schemas.page(Schemas.CampaignSummary, Schemas.EntityCursor),
      error: [HttpApiError.BadRequestNoContent, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: Schemas.EntityId },
      payload: Schemas.UpdateCampaignPayload,
      success: Schemas.Campaign,
      error: [
        HttpApiError.BadRequestNoContent,
        Schemas.NotFound,
        Schemas.CampaignStateConflict,
        Schemas.PayloadTooLarge,
        Schemas.StorageUnavailable,
      ],
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [
        HttpApiError.BadRequestNoContent,
        Schemas.NotFound,
        Schemas.CampaignStateConflict,
        Schemas.StorageUnavailable,
      ],
    }),
    HttpApiEndpoint.post("preview", "/:id/preview", {
      params: { id: Schemas.EntityId },
      success: Schemas.PreviewLink,
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.post("test", "/:id/test", {
      params: { id: Schemas.EntityId },
      payload: Schemas.TestSendPayload,
      success: Schemas.TestSendResult,
      error: [
        HttpApiError.BadRequestNoContent,
        Schemas.NotFound,
        Schemas.TestAudienceTooLarge,
        Schemas.SendingPaused,
        Schemas.PayloadTooLarge,
        Schemas.StorageUnavailable,
      ],
    }),
    HttpApiEndpoint.post("send", "/:id/send", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.post("resume", "/:id/resume", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: [HttpApiError.BadRequestNoContent, Schemas.NotFound, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.post("schedule", "/:id/schedule", {
      params: { id: Schemas.EntityId },
      payload: Schemas.ScheduleCampaignPayload,
      success: Schemas.Campaign,
      error: [
        HttpApiError.BadRequestNoContent,
        Schemas.NotFound,
        Schemas.SendAtNotInFuture,
        Schemas.StorageUnavailable,
      ],
    }),
    HttpApiEndpoint.post("cancel", "/:id/cancel", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: [
        HttpApiError.BadRequestNoContent,
        Schemas.NotFound,
        Schemas.CampaignStateConflict,
        Schemas.StorageUnavailable,
      ],
    }),
  )
  .middleware(Authorization)
  .prefix("/campaigns") {}

export class AddressesGroup extends HttpApiGroup.make("addresses")
  .add(
    HttpApiEndpoint.get("status", "/status", {
      query: { email: Schemas.ListedEmailAddress },
      success: Schemas.AddressRecord,
      error: [HttpApiError.BadRequestNoContent, Schemas.StorageUnavailable],
    }),
    HttpApiEndpoint.post("unsuppress", "/unsuppress", {
      payload: Schema.Struct({ email: Schemas.ListedEmailAddress }),
      success: Schemas.AddressRecord,
      error: [HttpApiError.BadRequestNoContent, Schemas.StorageUnavailable],
    }),
  )
  .middleware(Authorization)
  .prefix("/addresses") {}

export class EmailerApi extends HttpApi.make("emailer")
  .add(ContactsGroup)
  .add(ListsGroup)
  .add(CampaignsGroup)
  .add(AddressesGroup) {}
