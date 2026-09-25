import { Context, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/unstable/httpapi";

import * as Errors from "./Errors.ts";
import * as Schemas from "./Schemas.ts";

/** The operator's token, which every administrative endpoint requires. */
export class AdminAuthorization extends HttpApiMiddleware.Service<AdminAuthorization>()(
  "emailer/Api/AdminAuthorization",
  {
    requiredForClient: true,
    security: { bearer: HttpApiSecurity.bearer },
    error: Errors.Unauthorized,
  },
) {}

/** The scoped key a sign-up request came with: the lists it may add to, and its confirm page. */
export class Integration extends Context.Service<
  Integration,
  {
    readonly keyId: string;
    readonly lists: ReadonlyArray<string>;
    readonly confirmUrl: string;
  }
>()("emailer/Api/Integration") {}

/** A scoped key, which only the sign-up endpoints accept. Checking it reads storage. */
export class SubscriptionAuthorization extends HttpApiMiddleware.Service<
  SubscriptionAuthorization,
  { provides: Integration; requires: never }
>()("emailer/Api/SubscriptionAuthorization", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: [Errors.Unauthorized, Errors.StorageUnavailable],
}) {}

const listingQuery = {
  cursor: Schema.optional(Schemas.EntityCursor),
  limit: Schema.optional(Schemas.PageSize),
};

/** Member listings page by member sort key, which is the contact's identifier. */
const memberQuery = {
  cursor: Schema.optional(Schemas.EntityId),
  limit: Schema.optional(Schemas.PageSize),
};

/**
 * Every endpoint can refuse a malformed request, and every endpoint reads or writes storage. Each
 * adds exactly the other errors it can answer.
 */
const storage = [HttpApiError.BadRequestNoContent, Errors.StorageUnavailable] as const;

class ContactsGroup extends HttpApiGroup.make("contacts")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schemas.CreateContactPayload,
      success: Schemas.Contact.pipe(HttpApiSchema.status(201)),
      error: [...storage, Errors.EmailAlreadyUsed],
    }),
    HttpApiEndpoint.get("list", "/", {
      query: listingQuery,
      success: Schemas.page(Schemas.Contact, Schemas.EntityCursor),
      error: storage,
    }),
    // A static segment wins over ":id" in the router regardless of declaration order.
    HttpApiEndpoint.get("getByEmail", "/by-email", {
      query: { email: Schemas.EmailAddress },
      success: Schemas.Contact,
      error: [...storage, Errors.ContactNotFound],
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schemas.EntityId },
      success: Schemas.Contact,
      error: [...storage, Errors.ContactNotFound],
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: Schemas.EntityId },
      payload: Schemas.UpdateContactPayload,
      success: Schemas.Contact,
      error: [
        ...storage,
        Errors.ContactNotFound,
        Errors.EmailAlreadyUsed,
        Errors.AddressOptedOut,
        Errors.ContactChanged,
      ],
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [...storage, Errors.ContactNotFound, Errors.ContactChanged],
    }),
  )
  .prefix("/contacts") {}

class ListsGroup extends HttpApiGroup.make("lists")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schemas.CreateListPayload,
      success: Schemas.ContactList.pipe(HttpApiSchema.status(201)),
      error: [...storage],
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schemas.EntityId },
      success: Schemas.ContactList,
      error: [...storage, Errors.ListNotFound],
    }),
    HttpApiEndpoint.get("list", "/", {
      query: listingQuery,
      success: Schemas.page(Schemas.ContactList, Schemas.EntityCursor),
      error: storage,
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: Schemas.EntityId },
      payload: Schemas.UpdateListPayload,
      success: Schemas.ContactList,
      error: [...storage, Errors.ListNotFound],
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [...storage, Errors.ListNotFound],
    }),
    HttpApiEndpoint.get("listMembers", "/:listId/members", {
      params: { listId: Schemas.EntityId },
      query: memberQuery,
      success: Schemas.page(Schemas.Contact, Schemas.EntityId),
      error: [...storage, Errors.ListNotFound],
    }),
    HttpApiEndpoint.put("addContact", "/:listId/members/:contactId", {
      params: { listId: Schemas.EntityId, contactId: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [...storage, Errors.ContactNotFound, Errors.ListNotFound],
    }),
    HttpApiEndpoint.delete("removeContact", "/:listId/members/:contactId", {
      params: { listId: Schemas.EntityId, contactId: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [...storage, Errors.ListNotFound],
    }),
    HttpApiEndpoint.post("import", "/:listId/contacts", {
      params: { listId: Schemas.EntityId },
      payload: Schemas.ImportContactsPayload,
      success: Schemas.ImportContactsResult,
      error: [...storage, Errors.ListNotFound, Errors.ContactChanged],
    }),
  )
  .prefix("/lists") {}

class CampaignsGroup extends HttpApiGroup.make("campaigns")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schemas.CreateCampaignPayload,
      success: Schemas.Campaign.pipe(HttpApiSchema.status(201)),
      error: [...storage, Errors.ListNotFound],
    }),
    HttpApiEndpoint.get("list", "/", {
      query: listingQuery,
      success: Schemas.page(Schemas.CampaignSummary, Schemas.EntityCursor),
      error: storage,
    }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: [...storage, Errors.CampaignNotFound],
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: Schemas.EntityId },
      payload: Schemas.UpdateCampaignPayload,
      success: Schemas.Campaign,
      error: [
        ...storage,
        Errors.CampaignNotFound,
        Errors.ListNotFound,
        Errors.CampaignStateConflict,
      ],
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [...storage, Errors.CampaignNotFound, Errors.CampaignStateConflict],
    }),
    HttpApiEndpoint.post("preview", "/:id/preview", {
      params: { id: Schemas.EntityId },
      success: Schemas.PreviewLink,
      error: [...storage, Errors.CampaignNotFound],
    }),
    HttpApiEndpoint.post("test", "/:id/test", {
      params: { id: Schemas.EntityId },
      payload: Schemas.TestSendPayload,
      success: Schemas.TestSendResult,
      // A send checks the account and the reputation alarms before anything goes out.
      error: [
        ...storage,
        Errors.EmailServiceUnavailable,
        Errors.AlarmsUnavailable,
        Errors.CampaignNotFound,
        Errors.ListNotFound,
        Errors.TestAudienceTooLarge,
        Errors.SendingPaused,
      ],
    }),
    HttpApiEndpoint.post("send", "/:id/send", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: [...storage, Errors.CampaignNotFound, Errors.QueueUnavailable],
    }),
    HttpApiEndpoint.post("resume", "/:id/resume", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: [...storage, Errors.CampaignNotFound, Errors.QueueUnavailable],
    }),
    HttpApiEndpoint.post("schedule", "/:id/schedule", {
      params: { id: Schemas.EntityId },
      payload: Schemas.ScheduleCampaignPayload,
      success: Schemas.Campaign,
      error: [
        ...storage,
        Errors.CampaignNotFound,
        Errors.SendAtNotInFuture,
        Errors.SchedulerUnavailable,
      ],
    }),
    HttpApiEndpoint.post("cancel", "/:id/cancel", {
      params: { id: Schemas.EntityId },
      success: Schemas.Campaign,
      error: [...storage, Errors.CampaignNotFound, Errors.CampaignStateConflict],
    }),
  )
  .prefix("/campaigns") {}

class AddressesGroup extends HttpApiGroup.make("addresses")
  .add(
    HttpApiEndpoint.get("status", "/status", {
      query: { email: Schemas.ListedEmailAddress },
      success: Schemas.AddressRecord,
      error: [...storage, Errors.EmailServiceUnavailable],
    }),
    HttpApiEndpoint.post("unsuppress", "/unsuppress", {
      payload: Schema.Struct({ email: Schemas.ListedEmailAddress }),
      success: Schemas.AddressRecord,
      error: [...storage, Errors.EmailServiceUnavailable],
    }),
  )
  .prefix("/addresses") {}

/** Scoped keys are created and revoked by the operator; a key never manages keys. */
class KeysGroup extends HttpApiGroup.make("keys")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schemas.CreateApiKeyPayload,
      success: Schemas.CreatedApiKey.pipe(HttpApiSchema.status(201)),
      error: storage,
    }),
    // Keys are few, and all of them sit in one partition, so the listing is not paged.
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(Schemas.ApiKey),
      error: storage,
    }),
    HttpApiEndpoint.delete("revoke", "/:id", {
      params: { id: Schemas.EntityId },
      success: HttpApiSchema.NoContent,
      error: [...storage, Errors.ApiKeyNotFound],
    }),
  )
  .prefix("/keys") {}

/**
 * `middleware` applies to the groups added before it and to none added after, so the order is the
 * access rule: everything above takes the admin token only.
 */
export class EmailerApi extends HttpApi.make("emailer")
  .add(ContactsGroup)
  .add(ListsGroup)
  .add(CampaignsGroup)
  .add(AddressesGroup)
  .add(KeysGroup)
  .middleware(AdminAuthorization) {}
