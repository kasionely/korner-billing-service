import axios from "axios";

function ensureProtocol(url: string): string {
  if (!/^https?:\/\//.test(url)) return `http://${url}`;
  return url;
}

const KORNER_MAIN_SERVICE_URL = ensureProtocol(process.env.KORNER_MAIN_SERVICE_URL || "http://localhost:3001");

const mainServiceAxios = axios.create({
  baseURL: KORNER_MAIN_SERVICE_URL,
  timeout: 5000,
});

export interface BarData {
  id: string;
  profile_id: string;
  is_monetized: boolean;
  monetized_details?: {
    price?: number;
    currencyCode?: string;
  };
  [key: string]: unknown;
}

export interface ProfileData {
  id: string;
  user_id: number;
  name?: string;
  [key: string]: unknown;
}

export interface UserData {
  id: number;
  email: string;
  [key: string]: unknown;
}

export const getUserByToken = async (token: string): Promise<UserData | null> => {
  try {
    const response = await mainServiceAxios.get("/internal/users/me", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    // Main-service returns { user: { id, email, ... } }
    return response.data.user ?? response.data;
  } catch (error) {
    console.error("Error fetching user by token from main service:", error);
    return null;
  }
};

export const getBarById = async (barId: string): Promise<BarData | null> => {
  try {
    const response = await mainServiceAxios.get(`/internal/bars/${barId}`);
    // Main-service returns { bar: { id, ... } }
    return response.data.bar ?? response.data;
  } catch (error) {
    console.error(`Error fetching bar ${barId} from main service:`, error);
    return null;
  }
};

export const getProfileById = async (profileId: string): Promise<ProfileData | null> => {
  try {
    const response = await mainServiceAxios.get(`/internal/profiles/${profileId}`);
    // Main-service returns { profile: { id, ... } }
    return response.data.profile ?? response.data;
  } catch (error) {
    console.error(`Error fetching profile ${profileId} from main service:`, error);
    return null;
  }
};

export const getUserIdByProfileId = async (profileId: string): Promise<number | null> => {
  try {
    const response = await mainServiceAxios.get(`/internal/profiles/${profileId}/user-id`);
    return response.data?.userId ?? response.data?.user_id ?? null;
  } catch (error) {
    console.error(`Error fetching user ID for profile ${profileId} from main service:`, error);
    return null;
  }
};
