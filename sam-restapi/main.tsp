import "@typespec/http";
import "@typespec/rest";

using TypeSpec.Http;

// ============================================================
// サービス定義
// ============================================================
@service(#{ title: "User Service" })
@server("https://api.example.com", "Production")
@useAuth(BearerAuth)
namespace UserApi;

// ============================================================
// 共通 enum
// ============================================================
enum Role {
  admin,
  member,
}

enum OrderStatus {
  pending,
  paid,
  shipped,
}

enum PostStatus {
  draft,
  published,
}

// ============================================================
// 共通モデル
// ============================================================
model User {
  @key userId: string;
  name: string;
  email: string;
  role: Role;
  createdAt: utcDateTime;
}

model UserProfile {
  userId: string;
  bio: string;
  avatarUrl: string;
}

model UserList {
  items: User[];
  nextCursor?: string;
}

model Post {
  id: string;
  authorId: string;
  title: string;
  content: string;
  status: PostStatus;
  publishedAt?: utcDateTime;
}

model Order {
  id: string;
  userId: string;
  total: decimal;
  currency: string;
  status: OrderStatus;
  createdAt: utcDateTime;
}

model Notification {
  id: string;
  message: string;
  read: boolean;
  createdAt: utcDateTime;
}

model UpdateProfileRequest {
  bio?: string;
  avatarUrl?: string;
}

model UpdateRoleRequest {
  role: Role;
}

model UpdateNotificationRequest {
  read: boolean;
}

model CartItem {
  productId: string;
  quantity: int32;
}

model Cart {
  items: CartItem[];
}

// ============================================================
// エラーモデル（ステータスコード別）
// ============================================================
@error
model BadRequest {
  @statusCode statusCode: 400;
  code: "bad_request";
  message: string;
}

@error
model Unauthorized {
  @statusCode statusCode: 401;
  code: "unauthorized";
  message: string;
}

@error
model Forbidden {
  @statusCode statusCode: 403;
  code: "forbidden";
  message: string;
}

@error
model NotFound {
  @statusCode statusCode: 404;
  code: "not_found";
  message: string;
}

@error
model ErrorResponse {
  code: string;
  message: string;
}

// ============================================================
// パターン1: /users/{userId}/...
// 用途:
//   - 管理者が他ユーザーを操作する
//   - 他人の公開リソース（投稿/フォロワー等）を参照する
// 注意:
//   - サーバー側で「リクエスト者 == userId or 管理者」の認可必須
//   - IDOR(Insecure Direct Object Reference)対策が要点
//   - 配下の操作は原則 admin スコープ必須（403 を返却する）
// ============================================================
@route("/users")
@tag("Users (by ID)")
interface Users {
  /**
   * ユーザー一覧（管理者向け）
   * 認可: admin スコープ必須。非管理者は 403。
   */
  @get list(@query limit?: int32, @query cursor?: string):
    | UserList
    | Unauthorized
    | Forbidden
    | ErrorResponse;

  /**
   * 特定ユーザー情報を取得
   * 認可: 管理者 or 本人のみ。それ以外は 403。存在しない userId は 404。
   */
  @get read(@path userId: string):
    | User
    | Unauthorized
    | Forbidden
    | NotFound
    | ErrorResponse;

  /**
   * ロール変更
   * 認可: 管理者のみ。
   */
  @route("{userId}/role")
  @patch
  updateRole(@path userId: string, @body body: UpdateRoleRequest):
    | User
    | Unauthorized
    | Forbidden
    | NotFound
    | ErrorResponse;

  /**
   * ユーザー削除
   * 認可: 管理者のみ。
   */
  @delete remove(@path userId: string):
    | void
    | Unauthorized
    | Forbidden
    | NotFound
    | ErrorResponse;

  /** 特定ユーザーの公開投稿一覧（誰でも閲覧可） */
  @route("{userId}/posts")
  @get
  listPosts(@path userId: string): Post[] | NotFound | ErrorResponse;

  /** 特定ユーザーのフォロワー（公開） */
  @route("{userId}/followers")
  @get
  listFollowers(@path userId: string): User[] | NotFound | ErrorResponse;
}

// ============================================================
// パターン2: /me/...
// 用途:
//   - 認証済みユーザー本人の操作
//   - userIdをパスに含めず、Authorizationヘッダから特定
// メリット:
//   - URLがシンプル
//   - 他人のIDを誤って指定する事故が起きない
//   - 認可チェックがシンプルになる（IDマッチ不要）
// ============================================================
@route("/me")
@tag("Me (current user)")
interface Me {
  /** 自分のプロフィール取得 */
  @get getProfile(): UserProfile | Unauthorized | ErrorResponse;

  /** 自分のプロフィール更新 */
  @patch updateProfile(@body body: UpdateProfileRequest):
    | UserProfile
    | Unauthorized
    | BadRequest
    | ErrorResponse;

  /** 自分の通知一覧 */
  @route("notifications")
  @get
  listNotifications(@query unreadOnly?: boolean):
    | Notification[]
    | Unauthorized
    | ErrorResponse;

  /**
   * 通知を更新（既読化など）
   * REST 的に「動詞 URL」を避け、PATCH で状態を更新する。
   */
  @route("notifications/{notificationId}")
  @patch
  updateNotification(
    @path notificationId: string,
    @body body: UpdateNotificationRequest,
  ): Notification | Unauthorized | NotFound | ErrorResponse;

  /** 自分の注文一覧 */
  @route("orders")
  @get
  listOrders(@query status?: OrderStatus):
    | Order[]
    | Unauthorized
    | ErrorResponse;

  /** 自分のカート取得 */
  @route("cart")
  @get
  getCart(): Cart | Unauthorized | ErrorResponse;

  /** 自分の投稿（下書き含む） */
  @route("posts")
  @get
  listMyPosts(@query includeDrafts?: boolean):
    | Post[]
    | Unauthorized
    | ErrorResponse;
}
