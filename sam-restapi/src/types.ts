export type Role = "admin" | "member";
export type OrderStatus = "pending" | "paid" | "shipped";
export type PostStatus = "draft" | "published";

export interface User {
  userId: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface UserProfile {
  userId: string;
  bio: string;
  avatarUrl: string;
}

export interface UserList {
  items: User[];
  nextCursor?: string;
}

export interface Post {
  id: string;
  authorId: string;
  title: string;
  content: string;
  status: PostStatus;
  publishedAt?: string;
}

export interface Order {
  id: string;
  userId: string;
  total: string;
  currency: string;
  status: OrderStatus;
  createdAt: string;
}

export interface Notification {
  id: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface Cart {
  items: CartItem[];
}

export interface UpdateProfileRequest {
  bio?: string;
  avatarUrl?: string;
}

export interface UpdateRoleRequest {
  role: Role;
}

export interface UpdateNotificationRequest {
  read: boolean;
}

export interface ErrorResponse {
  code: string;
  message: string;
}
